/**
 * Ticketing Routes — Ticket retrieval, resend QR
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import * as crypto from "crypto";
import { TicketingService } from "./ticketing.service.js";

export async function ticketingRoutes(app: FastifyInstance) {
  const ticketingService = new TicketingService();

  // GET /ticket/:id
  app.get(
    "/ticket/:id",
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const ticket = await app.prisma.ticket.findUnique({
        where: { id },
        include: {
          seat: {
            include: {
              departure: {
                include: {
                  route: {
                    include: {
                      origin_city: true,
                      destination_city: true,
                    },
                  },
                  bus: { select: { model: true } },
                },
              },
            },
          },
          transaction: {
            select: {
              payment_mode: true,
              payment_status: true,
              amount: true,
            },
          },
        },
      });

      if (!ticket) {
        return reply.status(404).send({ error: "Ticket not found", code: "NOT_FOUND" });
      }

      if (ticket.invalidated_at) {
        return reply.status(410).send({
          error: "Ticket has been invalidated",
          code: "TICKET_INVALIDATED",
        });
      }

      // Clients can only access their own tickets (via phone hash)
      if (request.user.role === "client") {
        const phoneHeader = request.headers["x-passenger-phone"] as string;
        if (phoneHeader) {
          const phoneHash = crypto
            .createHash("sha256")
            .update(phoneHeader)
            .digest("hex");
          if (phoneHash !== ticket.passenger_phone_hash) {
            return reply.status(403).send({
              error: "Access denied",
              code: "INSUFFICIENT_ROLE",
            });
          }
        }
      }

      return reply.status(200).send(ticket);
    }
  );

  // POST /ticket/:id/resend
  app.post(
    "/ticket/:id/resend",
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = z
        .object({
          phone: z.string().regex(/^\+[1-9]\d{8,14}$/),
          method: z.enum(["sms", "whatsapp"]).optional(),
        })
        .safeParse(request.body);

      if (!body.success) {
        return reply.status(400).send({
          error: "Invalid request body",
          code: "VALIDATION_ERROR",
        });
      }

      try {
        await ticketingService.resendTicket({
          ticketId: id,
          passengerPhone: body.data.phone,
          method: body.data.method,
        });
        return reply.status(200).send({ queued: true });
      } catch (err: unknown) {
        const error = err as { message?: string };
        if (error.message?.includes("does not match")) {
          return reply.status(403).send({
            error: "Phone number does not match ticket",
            code: "PHONE_MISMATCH",
          });
        }
        if (error.message?.includes("invalidated")) {
          return reply.status(410).send({
            error: "Ticket is invalidated",
            code: "TICKET_INVALIDATED",
          });
        }
        throw err;
      }
    }
  );
}
