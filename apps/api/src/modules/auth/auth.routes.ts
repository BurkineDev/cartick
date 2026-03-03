/**
 * Auth Routes — Login, Refresh, Logout
 * Rate limiting: 5 attempts / 15min per IP (login)
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AuthService } from "./auth.service.js";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(100),
  device_id: z.string().optional(),
});

export async function authRoutes(app: FastifyInstance) {
  const authService = new AuthService(app.redis);

  // POST /auth/login
  app.post(
    "/auth/login",
    {
      config: { rateLimit: { max: 5, timeWindow: "15 minutes" } },
    },
    async (request, reply) => {
      const body = loginSchema.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({
          error: "Invalid request body",
          code: "VALIDATION_ERROR",
          details: body.error.flatten().fieldErrors,
        });
      }

      const ipAddress =
        request.headers["x-forwarded-for"]?.toString().split(",")[0] ??
        request.ip;

      const result = await authService.login(
        body.data.email,
        body.data.password,
        body.data.device_id,
        ipAddress
      );

      if (!result) {
        // Audit log attempt
        await app.prisma.auditLog.create({
          data: {
            action: "LOGIN_FAILED",
            resource: "auth",
            data: { email: body.data.email },
            ip_address: ipAddress,
            user_agent: request.headers["user-agent"],
          },
        });
        return reply.status(401).send({
          error: "Invalid credentials",
          code: "INVALID_CREDENTIALS",
        });
      }

      // Set refresh token as httpOnly secure cookie
      reply.setCookie("refresh_token", result.refreshToken, {
        httpOnly: true,
        secure: process.env["NODE_ENV"] === "production",
        sameSite: "strict",
        expires: result.refreshTokenExpiresAt,
        path: "/auth",
      });

      await app.prisma.auditLog.create({
        data: {
          user_id: result.user.id,
          action: "LOGIN_SUCCESS",
          resource: "auth",
          ip_address: ipAddress,
          user_agent: request.headers["user-agent"],
        },
      });

      return reply.status(200).send({
        access_token: result.accessToken,
        token_type: "Bearer",
        expires_in: 900, // 15 minutes
        user: result.user,
      });
    }
  );

  // POST /auth/refresh
  app.post("/auth/refresh", async (request, reply) => {
    const refreshToken = request.cookies["refresh_token"];
    if (!refreshToken) {
      return reply.status(401).send({
        error: "Refresh token missing",
        code: "MISSING_REFRESH_TOKEN",
      });
    }

    const ipAddress =
      request.headers["x-forwarded-for"]?.toString().split(",")[0] ??
      request.ip;

    const result = await authService.rotateRefreshToken(
      refreshToken,
      request.headers["x-device-id"]?.toString(),
      ipAddress
    );

    if (!result) {
      reply.clearCookie("refresh_token", { path: "/auth" });
      return reply.status(401).send({
        error: "Invalid or expired refresh token",
        code: "INVALID_REFRESH_TOKEN",
      });
    }

    // Issue new access token
    const accessToken = await authService.generateAccessToken({
      sub: result.user.id,
      company_id: result.user.company_id,
      role: result.user.role,
    });

    reply.setCookie("refresh_token", result.newToken, {
      httpOnly: true,
      secure: process.env["NODE_ENV"] === "production",
      sameSite: "strict",
      expires: result.expiresAt,
      path: "/auth",
    });

    return reply.status(200).send({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: 900,
    });
  });

  // POST /auth/logout
  app.post(
    "/auth/logout",
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const refreshToken = request.cookies["refresh_token"];

      if (refreshToken) {
        const crypto = await import("crypto");
        const tokenHash = crypto
          .createHash("sha256")
          .update(refreshToken)
          .digest("hex");
        await authService.blacklistToken(tokenHash);
      }

      await authService.revokeAllUserTokens(request.user.sub);
      reply.clearCookie("refresh_token", { path: "/auth" });

      await app.prisma.auditLog.create({
        data: {
          user_id: request.user.sub,
          action: "LOGOUT",
          resource: "auth",
          ip_address: request.ip,
        },
      });

      return reply.status(200).send({ message: "Logged out successfully" });
    }
  );
}
