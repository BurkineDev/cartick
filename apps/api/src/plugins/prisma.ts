/**
 * Prisma plugin — Singleton db client
 */
import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";
import { PrismaClient } from "@buskinaticket/database";

declare module "fastify" {
  interface FastifyInstance {
    prisma: PrismaClient;
  }
}

const prismaPlugin: FastifyPluginAsync = fp(async (app) => {
  const prisma = new PrismaClient({
    log:
      process.env["NODE_ENV"] === "development"
        ? ["error", "warn"]
        : ["error"],
  });

  await prisma.$connect();
  app.log.info("PostgreSQL connected via Prisma");

  app.decorate("prisma", prisma);

  app.addHook("onClose", async () => {
    await prisma.$disconnect();
  });
});

export default prismaPlugin;
