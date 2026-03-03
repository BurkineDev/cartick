/**
 * BuskinaTicket API Server
 * Node.js + Fastify — Monolithe Modulaire
 *
 * Version: 2.0.0
 */
import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import cookie from "@fastify/cookie";

import { env } from "./config/env.js";
import prismaPlugin from "./plugins/prisma.js";
import redisPlugin from "./plugins/redis.js";
import authPlugin from "./plugins/auth.js";

// Modules
import { authRoutes } from "./modules/auth/auth.routes.js";
import { inventoryRoutes } from "./modules/inventory/inventory.routes.js";
import { paymentRoutes } from "./modules/payment/payment.routes.js";
import { ticketingRoutes } from "./modules/ticketing/ticketing.routes.js";
import { boardingRoutes } from "./modules/boarding/boarding.routes.js";
import { reportingRoutes } from "./modules/reporting/reporting.routes.js";

// Jobs
import {
  createHoldCleanupJob,
  createReconciliationAlertJob,
} from "./jobs/cleanup.job.js";

async function buildServer() {
  const app = Fastify({
    logger: {
      level: env.NODE_ENV === "production" ? "info" : "debug",
      transport:
        env.NODE_ENV !== "production"
          ? { target: "pino-pretty", options: { colorize: true } }
          : undefined,
    },
    trustProxy: true, // Derrière Nginx
  });

  // ─── Security Plugins ──────────────────────────────────────────────────────

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
      },
    },
  });

  await app.register(cors, {
    origin: env.CORS_ORIGINS.split(",").map((o) => o.trim()),
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-Idempotency-Key",
      "X-Device-Id",
      "X-Passenger-Phone",
    ],
  });

  await app.register(rateLimit, {
    global: true,
    max: 200,
    timeWindow: "1 minute",
    redis: app.redis,
    keyGenerator: (request) => {
      // Rate limit par user_id si authentifié, sinon par IP
      return (
        (request as { user?: { sub?: string } }).user?.sub ??
        request.headers["x-forwarded-for"]?.toString() ??
        request.ip
      );
    },
    errorResponseBuilder: () => ({
      error: "Too many requests",
      code: "RATE_LIMIT_EXCEEDED",
    }),
  });

  await app.register(cookie, {
    secret: env.JWT_PRIVATE_KEY.slice(0, 32),
  });

  // ─── Infrastructure Plugins ────────────────────────────────────────────────

  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);

  // ─── Routes ────────────────────────────────────────────────────────────────

  const API_PREFIX = "/v1";

  await app.register(
    async (router) => {
      await router.register(authRoutes);
      await router.register(inventoryRoutes);
      await router.register(paymentRoutes);
      await router.register(ticketingRoutes);
      await router.register(boardingRoutes);
      await router.register(reportingRoutes);
    },
    { prefix: API_PREFIX }
  );

  // ─── Health Check ──────────────────────────────────────────────────────────

  app.get("/health", async (_request, reply) => {
    const checks: Record<string, "ok" | "error"> = {
      api: "ok",
      database: "ok",
      redis: "ok",
    };

    // Check database
    try {
      await app.prisma.$queryRaw`SELECT 1`;
    } catch {
      checks["database"] = "error";
    }

    // Check redis
    try {
      await app.redis.ping();
    } catch {
      checks["redis"] = "error";
    }

    const isHealthy = Object.values(checks).every((v) => v === "ok");
    return reply.status(isHealthy ? 200 : 503).send({
      status: isHealthy ? "healthy" : "degraded",
      version: "2.0.0",
      timestamp: new Date().toISOString(),
      checks,
    });
  });

  // ─── Error Handler ─────────────────────────────────────────────────────────

  app.setErrorHandler(async (error, request, reply) => {
    app.log.error({ err: error, url: request.url }, "Unhandled error");

    if (reply.statusCode === 200) {
      reply.status(500);
    }

    return reply.send({
      error: "Internal server error",
      code: "INTERNAL_ERROR",
    });
  });

  return app;
}

async function main() {
  const app = await buildServer();

  // Démarrer les jobs de background
  const holdCleanupTimer = createHoldCleanupJob(app.redis);
  const reconciliationAlertTimer = createReconciliationAlertJob(app.redis);

  // Graceful shutdown
  const shutdown = async () => {
    app.log.info("Shutting down gracefully...");
    clearInterval(holdCleanupTimer);
    clearInterval(reconciliationAlertTimer);
    await app.close();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  try {
    await app.listen({ port: env.PORT, host: env.HOST });
    app.log.info(
      `🚀 BuskinaTicket API running on ${env.HOST}:${env.PORT}`
    );
  } catch (err) {
    app.log.error(err, "Failed to start server");
    process.exit(1);
  }
}

main();
