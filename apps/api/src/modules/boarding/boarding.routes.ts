/**
 * Boarding Routes — QR Scan, Offline Sync
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { BoardingService } from "./boarding.service.js";
import { requireRole } from "../auth/rbac.js";

export async function boardingRoutes(app: FastifyInstance) {
  const boardingService = new BoardingService(app.redis);

  // POST /scanner/verify
  app.post(
    "/scanner/verify",
    {
      onRequest: [app.authenticate, requireRole("scanner", "company_admin", "super_admin")],
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const body = z
        .object({
          qr_payload: z.string(),
          departure_id: z.string().uuid(),
        })
        .safeParse(request.body);

      if (!body.success) {
        return reply.status(400).send({
          error: "Invalid request body",
          code: "VALIDATION_ERROR",
        });
      }

      const result = await boardingService.verifyAndBoard({
        qrPayload: body.data.qr_payload,
        scannerId: request.user.sub,
        expectedDepartureId: body.data.departure_id,
      });

      if (!result.valid) {
        const statusCode =
          result.code === "TICKET_ALREADY_BOARDED" ? 409
          : result.code === "QR_WRONG_DEPARTURE" ? 422
          : result.code === "INVALID_QR_SIGNATURE" ? 422
          : 400;

        return reply.status(statusCode).send({
          error: result.error,
          code: result.code,
        });
      }

      return reply.status(200).send({
        valid: true,
        passenger_name: result.passengerName,
        seat_number: result.seatNumber,
        route: result.routeCode,
      });
    }
  );

  // POST /scanner/sync-queue
  app.post(
    "/scanner/sync-queue",
    {
      onRequest: [app.authenticate, requireRole("scanner", "company_admin", "super_admin")],
    },
    async (request, reply) => {
      const body = z
        .object({
          boardings: z.array(
            z.object({
              qr_payload: z.string(),
              departure_id: z.string().uuid(),
              scanned_at: z.string().datetime(),
            })
          ).max(500), // Limite sécurité
        })
        .safeParse(request.body);

      if (!body.success) {
        return reply.status(400).send({
          error: "Invalid request body",
          code: "VALIDATION_ERROR",
        });
      }

      const result = await boardingService.syncOfflineQueue({
        scannerId: request.user.sub,
        boardings: body.data.boardings,
      });

      return reply.status(200).send(result);
    }
  );

  // GET /scanner/departure/:id
  app.get(
    "/scanner/departure/:id",
    {
      onRequest: [app.authenticate, requireRole("scanner", "company_admin", "super_admin")],
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const data = await boardingService.getDepartureForScanner(
        id,
        request.user.sub
      );

      if (!data) {
        return reply.status(404).send({ error: "Departure not found", code: "NOT_FOUND" });
      }

      return reply.status(200).send(data);
    }
  );
}
