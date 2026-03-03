/**
 * Redis plugin — Singleton connexion avec BullMQ queue
 */
import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";
import { Redis } from "ioredis";
import { Queue } from "bullmq";
import { env } from "../config/env.js";

declare module "fastify" {
  interface FastifyInstance {
    redis: Redis;
    paymentQueue: Queue;
  }
}

const redisPlugin: FastifyPluginAsync = fp(async (app) => {
  const redis = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null, // Requis par BullMQ
    enableReadyCheck: false,
  });

  redis.on("error", (err) => {
    app.log.error({ err }, "Redis connection error");
  });

  redis.on("connect", () => {
    app.log.info("Redis connected");
  });

  const paymentQueue = new Queue("payment", {
    connection: redis,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 2000 },
      removeOnComplete: { age: 24 * 60 * 60 }, // Garder 24h
      removeOnFail: { age: 7 * 24 * 60 * 60 },  // Garder 7 jours
    },
  });

  app.decorate("redis", redis);
  app.decorate("paymentQueue", paymentQueue);

  app.addHook("onClose", async () => {
    await paymentQueue.close();
    await redis.quit();
  });
});

export default redisPlugin;
