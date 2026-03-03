/**
 * Auth Service — JWT RS256, RBAC, Refresh Token Rotation
 *
 * Access Token:  RS256 asymmetric, TTL 15min
 * Refresh Token: stored as httpOnly cookie, TTL 7d, rotated on use
 * Blacklist:     Redis for immediate invalidation
 */
import { prisma } from "@buskinaticket/database";
import type { UserRole } from "@buskinaticket/database";
import * as bcrypt from "bcrypt";
import * as crypto from "crypto";
import { SignJWT, jwtVerify, importPKCS8, importSPKI } from "jose";
import type { Redis } from "ioredis";
import { env } from "../../config/env.js";
import type { JwtPayload } from "../../types/index.js";

const BCRYPT_ROUNDS = 12;
const REFRESH_TOKEN_BLACKLIST_PREFIX = "blacklist:refresh:";

export class AuthService {
  constructor(private readonly redis: Redis) {}

  async hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, BCRYPT_ROUNDS);
  }

  async verifyPassword(password: string, hash: string): Promise<boolean> {
    return bcrypt.compare(password, hash);
  }

  async generateAccessToken(payload: Omit<JwtPayload, "type">): Promise<string> {
    const privateKey = await importPKCS8(env.JWT_PRIVATE_KEY, "RS256");
    return new SignJWT({ ...payload, type: "access" })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuedAt()
      .setExpirationTime(env.JWT_ACCESS_TOKEN_TTL)
      .setIssuer("buskinaticket.bf")
      .sign(privateKey);
  }

  async generateRefreshToken(
    userId: string,
    deviceId?: string,
    ipAddress?: string
  ): Promise<{ token: string; tokenHash: string; expiresAt: Date }> {
    // Refresh token is a random secure token (not JWT)
    const token = crypto.randomBytes(64).toString("hex");
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7); // 7 days

    await prisma.refreshToken.create({
      data: {
        user_id: userId,
        token_hash: tokenHash,
        device_id: deviceId,
        ip_address: ipAddress,
        expires_at: expiresAt,
      },
    });

    return { token, tokenHash, expiresAt };
  }

  async verifyAccessToken(token: string): Promise<JwtPayload> {
    const publicKey = await importSPKI(env.JWT_PUBLIC_KEY, "RS256");
    const { payload } = await jwtVerify(token, publicKey, {
      issuer: "buskinaticket.bf",
    });
    return payload as unknown as JwtPayload;
  }

  /**
   * Rotate refresh token — invalidates old, creates new
   * Returns null if token is invalid, expired, or blacklisted
   */
  async rotateRefreshToken(
    token: string,
    deviceId?: string,
    ipAddress?: string
  ): Promise<{
    user: { id: string; role: UserRole; company_id: string | null };
    newToken: string;
    expiresAt: Date;
  } | null> {
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

    // Check blacklist first (immediate invalidation)
    const isBlacklisted = await this.redis.exists(
      `${REFRESH_TOKEN_BLACKLIST_PREFIX}${tokenHash}`
    );
    if (isBlacklisted) return null;

    const stored = await prisma.refreshToken.findUnique({
      where: { token_hash: tokenHash },
      include: { user: { select: { id: true, role: true, company_id: true } } },
    });

    if (
      !stored ||
      stored.revoked_at !== null ||
      stored.expires_at < new Date()
    ) {
      return null;
    }

    // Revoke old token
    await prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revoked_at: new Date() },
    });

    // Issue new token
    const { token: newToken, expiresAt } = await this.generateRefreshToken(
      stored.user_id,
      deviceId,
      ipAddress
    );

    return { user: stored.user, newToken, expiresAt };
  }

  /**
   * Invalidate all refresh tokens for a user (logout all devices)
   */
  async revokeAllUserTokens(userId: string): Promise<void> {
    await prisma.refreshToken.updateMany({
      where: { user_id: userId, revoked_at: null },
      data: { revoked_at: new Date() },
    });
  }

  /**
   * Blacklist a specific refresh token hash in Redis for immediate effect
   * TTL matches refresh token TTL (7 days)
   */
  async blacklistToken(tokenHash: string): Promise<void> {
    await this.redis.setex(
      `${REFRESH_TOKEN_BLACKLIST_PREFIX}${tokenHash}`,
      7 * 24 * 60 * 60, // 7 days in seconds
      "1"
    );
  }

  async login(
    email: string,
    password: string,
    deviceId?: string,
    ipAddress?: string
  ): Promise<{
    accessToken: string;
    refreshToken: string;
    refreshTokenExpiresAt: Date;
    user: {
      id: string;
      email: string;
      role: UserRole;
      company_id: string | null;
      first_name: string;
      last_name: string;
    };
  } | null> {
    const user = await prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        password_hash: true,
        role: true,
        company_id: true,
        first_name: true,
        last_name: true,
        is_active: true,
      },
    });

    if (!user || !user.is_active) return null;

    const passwordValid = await this.verifyPassword(password, user.password_hash);
    if (!passwordValid) return null;

    await prisma.user.update({
      where: { id: user.id },
      data: { last_login_at: new Date() },
    });

    const accessToken = await this.generateAccessToken({
      sub: user.id,
      company_id: user.company_id,
      role: user.role,
      device_id: deviceId,
    });

    const { token: refreshToken, expiresAt: refreshTokenExpiresAt } =
      await this.generateRefreshToken(user.id, deviceId, ipAddress);

    return {
      accessToken,
      refreshToken,
      refreshTokenExpiresAt,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        company_id: user.company_id,
        first_name: user.first_name,
        last_name: user.last_name,
      },
    };
  }
}
