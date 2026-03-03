/**
 * Payment Routes — Mobile Money initiation, status, webhooks, cash sales
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import * as crypto from "crypto";
import { PaymentService } from "./payment.service.js";
import { requireRole } from "../auth/rbac.js";
import { env } from "../../config/env.js";

export async function paymentRoutes(app: FastifyInstance) {
  const paymentService = new PaymentService(app.redis, app.paymentQueue);

  // POST /initiate-payment
  app.post(
    "/initiate-payment",
    {
      onRequest: [app.authenticate],
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const idempotencyKey = request.headers["x-idempotency-key"] as string;
      if (!idempotencyKey) {
        return reply.status(400).send({
          error: "X-Idempotency-Key header is required",
          code: "MISSING_IDEMPOTENCY_KEY",
        });
      }

      const body = z
        .object({
          seat_id: z.string().uuid(),
          session_id: z.string().uuid(),
          mode: z.enum(["orange_money", "moov_money", "wave"]),
          phone: z.string().regex(/^\+[1-9]\d{8,14}$/),
          passenger_name: z.string().min(2).max(200),
          delivery_method: z.enum(["sms", "whatsapp", "print", "app"]).default("sms"),
        })
        .safeParse(request.body);

      if (!body.success) {
        return reply.status(400).send({
          error: "Invalid request body",
          code: "VALIDATION_ERROR",
          details: body.error.flatten().fieldErrors,
        });
      }

      // Get seat price from the hold
      const seat = await app.prisma.seat.findUnique({
        where: { id: body.data.seat_id },
        include: {
          departure: {
            include: {
              route: { select: { base_price: true, vip_price: true } },
            },
          },
        },
      });

      if (!seat) {
        return reply.status(404).send({ error: "Seat not found", code: "NOT_FOUND" });
      }

      const price =
        seat.seat_type === "vip"
          ? Number(seat.departure.route.vip_price ?? seat.departure.route.base_price)
          : Number(seat.departure.route.base_price);

      const result = await paymentService.initiatePayment({
        idempotencyKey,
        seatId: body.data.seat_id,
        sessionId: body.data.session_id,
        amount: price,
        mode: body.data.mode,
        customerPhone: body.data.phone,
        ticketData: {
          passengerName: body.data.passenger_name,
          passengerPhone: body.data.phone,
          deliveryMethod: body.data.delivery_method,
        },
      });

      return reply.status(202).send(result);
    }
  );

  // GET /payment/:id/status
  app.get(
    "/payment/:id/status",
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const status = await paymentService.getPaymentStatus(id);

      if (!status) {
        return reply.status(404).send({ error: "Transaction not found", code: "NOT_FOUND" });
      }

      return reply.status(200).send(status);
    }
  );

  // ─── Agent Routes ───────────────────────────────────────────────────────────

  // POST /agent/cash-sale
  app.post(
    "/agent/cash-sale",
    {
      onRequest: [app.authenticate, requireRole("agent", "company_admin", "super_admin")],
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const idempotencyKey = request.headers["x-idempotency-key"] as string;
      if (!idempotencyKey) {
        return reply.status(400).send({
          error: "X-Idempotency-Key header is required",
          code: "MISSING_IDEMPOTENCY_KEY",
        });
      }

      const body = z
        .object({
          departure_id: z.string().uuid(),
          seat_id: z.string().uuid(),
          passenger: z.object({
            name: z.string().min(2).max(200),
            phone: z.string().regex(/^\+[1-9]\d{8,14}$/),
            id_type: z.enum(["cni", "passport", "permis"]).optional(),
            id_number: z.string().optional(),
          }),
          delivery_method: z.enum(["sms", "whatsapp", "print"]),
        })
        .safeParse(request.body);

      if (!body.success) {
        return reply.status(400).send({
          error: "Invalid request body",
          code: "VALIDATION_ERROR",
          details: body.error.flatten().fieldErrors,
        });
      }

      const companyId = request.user.company_id;
      if (!companyId) {
        return reply.status(403).send({ error: "No company", code: "NO_COMPANY" });
      }

      // Verify departure belongs to agent's company
      const departure = await app.prisma.departure.findFirst({
        where: {
          id: body.data.departure_id,
          company_id: companyId,
          manifest_locked: false,
        },
        include: {
          route: { select: { base_price: true, vip_price: true } },
          company: { select: { commission_rate: true } },
        },
      });

      if (!departure) {
        return reply.status(422).send({
          error: "Departure not found or closed",
          code: "DEPARTURE_CLOSED",
        });
      }

      // Determine price based on seat type
      const seat = await app.prisma.seat.findFirst({
        where: {
          id: body.data.seat_id,
          departure_id: body.data.departure_id,
        },
        select: { seat_type: true },
      });

      if (!seat) {
        return reply.status(404).send({ error: "Seat not found", code: "NOT_FOUND" });
      }

      const price =
        seat.seat_type === "vip"
          ? Number(departure.route.vip_price ?? departure.route.base_price)
          : Number(departure.route.base_price);

      try {
        const result = await paymentService.processCashSale({
          idempotencyKey,
          seatId: body.data.seat_id,
          departureId: body.data.departure_id,
          agentId: request.user.sub,
          amount: price,
          companyId,
          passengerName: body.data.passenger.name,
          passengerPhone: body.data.passenger.phone,
          deliveryMethod: body.data.delivery_method,
          platformFeeRate: Number(departure.company.commission_rate),
        });

        return reply.status(201).send(result);
      } catch (err: unknown) {
        const error = err as { code?: string };
        if (error.code === "SEAT_NOT_AVAILABLE") {
          return reply.status(409).send({
            error: "Seat is no longer available",
            code: "SEAT_NOT_AVAILABLE",
          });
        }
        throw err;
      }
    }
  );

  // POST /agent/cancel-ticket
  app.post(
    "/agent/cancel-ticket",
    {
      onRequest: [app.authenticate, requireRole("agent", "company_admin", "super_admin")],
    },
    async (request, reply) => {
      const body = z
        .object({
          seat_id: z.string().uuid(),
          reason: z.string().optional(),
        })
        .safeParse(request.body);

      if (!body.success) {
        return reply.status(400).send({ error: "Invalid body", code: "VALIDATION_ERROR" });
      }

      // Agents can only cancel their own sales (unless admin)
      const isAdmin =
        request.user.role === "company_admin" ||
        request.user.role === "super_admin";

      if (!isAdmin) {
        const seat = await app.prisma.seat.findUnique({
          where: { id: body.data.seat_id },
          select: { sold_by: true },
        });
        if (seat?.sold_by !== request.user.sub) {
          return reply.status(403).send({
            error: "Cannot cancel another agent's sale",
            code: "INSUFFICIENT_ROLE",
          });
        }
      }

      try {
        const { InventoryService } = await import("../inventory/inventory.service.js");
        const inventoryService = new InventoryService(app.redis);
        await inventoryService.cancelTicket({
          seatId: body.data.seat_id,
          requesterId: request.user.sub,
          reason: body.data.reason,
        });

        return reply.status(200).send({ cancelled: true });
      } catch (err: unknown) {
        const error = err as { code?: string; message?: string };
        if (error.code === "DEPARTURE_CLOSED") {
          return reply.status(422).send({
            error: "Cannot cancel after departure",
            code: "DEPARTURE_CLOSED",
          });
        }
        throw err;
      }
    }
  );

  // ─── Webhook Routes ─────────────────────────────────────────────────────────

  // POST /webhooks/orange-money
  app.post(
    "/webhooks/orange-money",
    {
      config: { rateLimit: { max: 100, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      // 1. Vérifier IP source dans la whitelist
      const allowedIps = env.ORANGE_MONEY_IPS.split(",").filter(Boolean);
      if (allowedIps.length > 0 && !allowedIps.includes(request.ip)) {
        app.log.warn({ ip: request.ip }, "Orange Money webhook from unauthorized IP");
        return reply.status(403).end();
      }

      // 2. Valider signature HMAC-SHA256
      const signature = request.headers["x-om-signature"] as string;
      if (env.ORANGE_MONEY_WEBHOOK_SECRET && signature) {
        const rawBody = JSON.stringify(request.body);
        const expected = crypto
          .createHmac("sha256", env.ORANGE_MONEY_WEBHOOK_SECRET)
          .update(rawBody)
          .digest("hex");

        // Comparaison timing-safe pour prévenir les attaques par timing
        if (
          !crypto.timingSafeEqual(
            Buffer.from(signature),
            Buffer.from(expected)
          )
        ) {
          app.log.warn("Orange Money webhook signature invalid");
          return reply.status(403).end();
        }
      }

      const body = request.body as {
        operator_ref: string;
        status: string;
        amount: number;
        idempotency_key?: string;
      };

      await paymentService.processWebhook({
        operatorRef: body.operator_ref,
        status: body.status as "success" | "failed" | "cancelled",
        amount: body.amount,
        idempotencyKey: body.idempotency_key ?? body.operator_ref,
      });

      // 202 Accepted — traitement asynchrone
      return reply.status(202).end();
    }
  );

  // POST /webhooks/moov-money
  app.post(
    "/webhooks/moov-money",
    {
      config: { rateLimit: { max: 100, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const allowedIps = env.MOOV_MONEY_IPS.split(",").filter(Boolean);
      if (allowedIps.length > 0 && !allowedIps.includes(request.ip)) {
        return reply.status(403).end();
      }

      const signature = request.headers["x-moov-signature"] as string;
      if (env.MOOV_MONEY_WEBHOOK_SECRET && signature) {
        const rawBody = JSON.stringify(request.body);
        const expected = crypto
          .createHmac("sha256", env.MOOV_MONEY_WEBHOOK_SECRET)
          .update(rawBody)
          .digest("hex");

        if (
          !crypto.timingSafeEqual(
            Buffer.from(signature),
            Buffer.from(expected)
          )
        ) {
          return reply.status(403).end();
        }
      }

      const body = request.body as {
        reference: string;
        status: string;
        amount: number;
      };

      await paymentService.processWebhook({
        operatorRef: body.reference,
        status: body.status as "success" | "failed" | "cancelled",
        amount: body.amount,
        idempotencyKey: body.reference,
      });

      return reply.status(202).end();
    }
  );
}
