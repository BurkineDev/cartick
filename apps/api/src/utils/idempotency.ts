/**
 * Idempotency utilities
 * Chaque requête de modification porte un X-Idempotency-Key côté client
 * Le serveur garde en cache les résultats (Redis, TTL 24h)
 */
import type { FastifyRequest, FastifyReply } from "fastify";

/**
 * Hook Fastify — vérifie la présence du header X-Idempotency-Key
 * pour les endpoints de mutation critiques
 */
export async function requireIdempotencyKey(
  request: FastifyRequest,
  reply: FastifyReply
) {
  const key = request.headers["x-idempotency-key"];
  if (!key || typeof key !== "string") {
    return reply.status(400).send({
      error: "X-Idempotency-Key header is required for this operation",
      code: "MISSING_IDEMPOTENCY_KEY",
    });
  }

  // Valider le format (UUID v4 recommandé)
  const uuidRegex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(key)) {
    return reply.status(400).send({
      error: "X-Idempotency-Key must be a valid UUID v4",
      code: "INVALID_IDEMPOTENCY_KEY",
    });
  }
}
