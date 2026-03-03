/**
 * Cryptographic utilities
 */
import * as crypto from "crypto";

/**
 * Hash d'un numéro de téléphone pour stockage RGPD-compliant
 * Utilise SHA-256 — recherche possible sans exposer le numéro en clair
 */
export function hashPhone(phone: string): string {
  return crypto.createHash("sha256").update(phone.trim()).digest("hex");
}

/**
 * Comparaison timing-safe pour les signatures HMAC
 * Prévient les attaques par timing
 */
export function timingSafeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Génère un token sécurisé aléatoire (refresh tokens, etc.)
 */
export function generateSecureToken(byteLength = 64): string {
  return crypto.randomBytes(byteLength).toString("hex");
}

/**
 * HMAC-SHA256 d'une chaîne
 */
export function hmacSha256(data: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(data).digest("hex");
}
