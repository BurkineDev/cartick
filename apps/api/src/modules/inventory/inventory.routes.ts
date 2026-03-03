/**
 * Inventory Routes — Departures, Buses, Seats
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { InventoryService } from "./inventory.service.js";
import { requirePermission, requireRole } from "../auth/rbac.js";

export async function inventoryRoutes(app: FastifyInstance) {
  const inventoryService = new InventoryService(app.redis);

  // ─── Public Routes ─────────────────────────────────────────────────────────

  // GET /cities
  app.get(
    "/cities",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (_request, reply) => {
      const cities = await app.prisma.city.findMany({
        where: { is_active: true },
        orderBy: { name: "asc" },
      });
      return reply.status(200).send(cities);
    }
  );

  // GET /routes
  app.get(
    "/routes",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const query = z
        .object({
          origin_city_id: z.string().uuid().optional(),
          destination_city_id: z.string().uuid().optional(),
        })
        .safeParse(request.query);

      const routes = await app.prisma.route.findMany({
        where: {
          is_active: true,
          ...(query.data?.origin_city_id && {
            origin_city_id: query.data.origin_city_id,
          }),
          ...(query.data?.destination_city_id && {
            destination_city_id: query.data.destination_city_id,
          }),
        },
        include: {
          origin_city: true,
          destination_city: true,
          company: { select: { id: true, name: true, slug: true } },
        },
        orderBy: { created_at: "asc" },
      });

      return reply.status(200).send(routes);
    }
  );

  // GET /departures
  app.get(
    "/departures",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const query = z
        .object({
          route_id: z.string().uuid(),
          date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          cursor: z.string().optional(),
          limit: z.coerce.number().min(1).max(50).default(20),
        })
        .safeParse(request.query);

      if (!query.success) {
        return reply.status(400).send({
          error: "Invalid query parameters",
          code: "VALIDATION_ERROR",
          details: query.error.flatten().fieldErrors,
        });
      }

      const { route_id, date, cursor, limit } = query.data;
      const startDate = new Date(`${date}T00:00:00Z`);
      const endDate = new Date(`${date}T23:59:59Z`);

      const departures = await app.prisma.departure.findMany({
        where: {
          route_id,
          departure_datetime: { gte: startDate, lte: endDate },
          status: { in: ["open", "boarding"] },
          ...(cursor && { id: { gt: cursor } }),
        },
        include: {
          route: {
            include: { origin_city: true, destination_city: true },
          },
          bus: { select: { model: true, capacity: true, vip_seat_count: true } },
          company: { select: { id: true, name: true } },
        },
        take: limit + 1,
        orderBy: { departure_datetime: "asc" },
      });

      const hasMore = departures.length > limit;
      const data = hasMore ? departures.slice(0, limit) : departures;
      const nextCursor = hasMore ? data[data.length - 1]?.id ?? null : null;

      return reply.status(200).send({
        data,
        cursor: nextCursor,
        has_more: hasMore,
      });
    }
  );

  // GET /departures/:id/seats
  app.get(
    "/departures/:id/seats",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const seatMap = await inventoryService.getDepartureSeatMap(id);

      if (!seatMap) {
        return reply.status(404).send({
          error: "Departure not found",
          code: "NOT_FOUND",
        });
      }

      return reply.status(200).send(seatMap);
    }
  );

  // POST /hold-seat
  app.post(
    "/hold-seat",
    {
      onRequest: [app.authenticate],
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const body = z
        .object({
          departure_id: z.string().uuid(),
          seat_id: z.string().uuid(),
          session_id: z.string().uuid(),
        })
        .safeParse(request.body);

      if (!body.success) {
        return reply.status(400).send({
          error: "Invalid request body",
          code: "VALIDATION_ERROR",
          details: body.error.flatten().fieldErrors,
        });
      }

      // Verify departure belongs to a valid company
      const departure = await app.prisma.departure.findUnique({
        where: { id: body.data.departure_id },
        select: { company_id: true, status: true, manifest_locked: true },
      });

      if (!departure) {
        return reply.status(404).send({ error: "Departure not found", code: "NOT_FOUND" });
      }
      if (departure.manifest_locked || departure.status === "departed" || departure.status === "cancelled") {
        return reply.status(422).send({ error: "Departure is closed", code: "DEPARTURE_CLOSED" });
      }

      try {
        const result = await inventoryService.holdSeat({
          seatId: body.data.seat_id,
          departureId: body.data.departure_id,
          sessionId: body.data.session_id,
          companyId: departure.company_id,
        });

        return reply.status(200).send({
          seat_id: body.data.seat_id,
          session_id: body.data.session_id,
          expires_at: result.expiresAt,
          seat_number: result.seatNumber,
        });
      } catch (err: unknown) {
        const error = err as { code?: string; statusCode?: number; message?: string };
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

  // POST /release-seat
  app.post(
    "/release-seat",
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const body = z
        .object({
          seat_id: z.string().uuid(),
          session_id: z.string().uuid(),
        })
        .safeParse(request.body);

      if (!body.success) {
        return reply.status(400).send({
          error: "Invalid request body",
          code: "VALIDATION_ERROR",
        });
      }

      await inventoryService.releaseSeat(body.data);
      return reply.status(200).send({ released: true });
    }
  );

  // ─── Company Routes ─────────────────────────────────────────────────────────

  // POST /company/departures
  app.post(
    "/company/departures",
    {
      onRequest: [app.authenticate, requirePermission("manage_buses_routes")],
    },
    async (request, reply) => {
      const body = z
        .object({
          route_id: z.string().uuid(),
          bus_id: z.string().uuid(),
          departure_datetime: z.string().datetime(),
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
        return reply.status(403).send({ error: "No company associated", code: "NO_COMPANY" });
      }

      // Verify route and bus belong to the company
      const [route, bus] = await Promise.all([
        app.prisma.route.findFirst({
          where: { id: body.data.route_id, company_id: companyId },
        }),
        app.prisma.bus.findFirst({
          where: { id: body.data.bus_id, company_id: companyId, is_active: true },
          select: { id: true, capacity: true, seat_layout_json: true, vip_seat_count: true },
        }),
      ]);

      if (!route) return reply.status(404).send({ error: "Route not found", code: "NOT_FOUND" });
      if (!bus) return reply.status(404).send({ error: "Bus not found", code: "NOT_FOUND" });

      // Create departure + seats atomically
      const departure = await app.prisma.$transaction(async (tx) => {
        const newDeparture = await tx.departure.create({
          data: {
            route_id: body.data.route_id,
            bus_id: body.data.bus_id,
            company_id: companyId,
            departure_datetime: new Date(body.data.departure_datetime),
            available_seats: bus.capacity,
          },
        });

        // Generate seat records from bus layout
        const layout = bus.seat_layout_json as {
          rows: Array<{
            row: number;
            seats: Array<{ number: string; type: string }>;
          }>;
        };

        const seatData = layout.rows.flatMap((row) =>
          row.seats.map((seat) => ({
            departure_id: newDeparture.id,
            seat_number: seat.number,
            seat_type: seat.type as "standard" | "vip" | "driver_adjacent",
            status: "free" as const,
          }))
        );

        await tx.seat.createMany({ data: seatData });

        return newDeparture;
      });

      return reply.status(201).send(departure);
    }
  );

  // PUT /company/departures/:id
  app.put(
    "/company/departures/:id",
    {
      onRequest: [app.authenticate, requirePermission("manage_buses_routes")],
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = z
        .object({
          status: z.enum(["open", "boarding", "cancelled"]),
        })
        .safeParse(request.body);

      if (!body.success) {
        return reply.status(400).send({ error: "Invalid body", code: "VALIDATION_ERROR" });
      }

      const companyId = request.user.company_id;
      const departure = await app.prisma.departure.findFirst({
        where: { id, company_id: companyId ?? undefined },
      });

      if (!departure) {
        return reply.status(404).send({ error: "Departure not found", code: "NOT_FOUND" });
      }

      const updated = await app.prisma.departure.update({
        where: { id },
        data: { status: body.data.status },
      });

      return reply.status(200).send(updated);
    }
  );

  // GET /company/departures/:id/manifest
  app.get(
    "/company/departures/:id/manifest",
    {
      onRequest: [app.authenticate, requirePermission("view_company_financial")],
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const companyId = request.user.company_id;

      const departure = await app.prisma.departure.findFirst({
        where: { id, company_id: companyId ?? undefined },
        include: {
          seats: {
            include: {
              ticket: {
                select: {
                  passenger_name: true,
                  delivery_method: true,
                  delivery_status: true,
                  issued_at: true,
                },
              },
            },
            orderBy: { seat_number: "asc" },
          },
          route: {
            include: { origin_city: true, destination_city: true },
          },
        },
      });

      if (!departure) {
        return reply.status(404).send({ error: "Departure not found", code: "NOT_FOUND" });
      }

      return reply.status(200).send(departure);
    }
  );

  // POST /company/buses
  app.post(
    "/company/buses",
    {
      onRequest: [app.authenticate, requirePermission("manage_buses_routes")],
    },
    async (request, reply) => {
      const body = z
        .object({
          registration_number: z.string().min(5).max(20),
          model: z.string().min(2).max(100),
          capacity: z.number().int().min(10).max(150),
          vip_seat_count: z.number().int().min(0).default(0),
          seat_layout_json: z.record(z.unknown()),
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
        return reply.status(403).send({ error: "No company associated", code: "NO_COMPANY" });
      }

      const bus = await app.prisma.bus.create({
        data: {
          company_id: companyId,
          ...body.data,
        },
      });

      return reply.status(201).send(bus);
    }
  );

  // GET /agent/departures
  app.get(
    "/agent/departures",
    {
      onRequest: [app.authenticate, requireRole("agent", "company_admin", "super_admin")],
    },
    async (request, reply) => {
      const companyId = request.user.company_id;
      if (!companyId) {
        return reply.status(403).send({ error: "No company associated", code: "NO_COMPANY" });
      }

      const today = new Date();
      const startOfDay = new Date(today.setHours(0, 0, 0, 0));
      const endOfDay = new Date(today.setHours(23, 59, 59, 999));

      const departures = await app.prisma.departure.findMany({
        where: {
          company_id: companyId,
          departure_datetime: { gte: startOfDay, lte: endOfDay },
          status: { in: ["open", "boarding"] },
          manifest_locked: false,
        },
        include: {
          route: {
            include: { origin_city: true, destination_city: true },
          },
          bus: { select: { model: true, capacity: true } },
          _count: {
            select: {
              seats: { where: { status: "free" } },
            },
          },
        },
        orderBy: { departure_datetime: "asc" },
      });

      return reply.status(200).send(departures);
    }
  );
}
