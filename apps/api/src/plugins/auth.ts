/**
 * Auth plugin — JWT verification hook + request user decoration
 */
import fp from "fastify-plugin";
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { jwtVerify, importSPKI } from "jose";
import { env } from "../config/env.js";
import type { JwtPayload } from "../types/index.js";

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (
      request: FastifyRequest,
      reply: FastifyReply
    ) => Promise<void>;
  }
  interface FastifyRequest {
    user: JwtPayload;
  }
}

const authPlugin: FastifyPluginAsync = fp(async (app) => {
  app.decorate(
    "authenticate",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const authHeader = request.headers.authorization;
      if (!authHeader?.startsWith("Bearer ")) {
        return reply.status(401).send({
          error: "Authorization header missing or invalid",
          code: "UNAUTHORIZED",
        });
      }

      const token = authHeader.slice(7);

      try {
        const publicKey = await importSPKI(env.JWT_PUBLIC_KEY, "RS256");
        const { payload } = await jwtVerify(token, publicKey, {
          issuer: "buskinaticket.bf",
        });

        if (payload["type"] !== "access") {
          return reply.status(401).send({
            error: "Invalid token type",
            code: "INVALID_TOKEN_TYPE",
          });
        }

        request.user = payload as unknown as JwtPayload;
      } catch {
        return reply.status(401).send({
          error: "Invalid or expired token",
          code: "INVALID_TOKEN",
        });
      }
    }
  );
});

export default authPlugin;
