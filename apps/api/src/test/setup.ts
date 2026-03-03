/**
 * Test setup — configure environment variables for tests
 */
import { vi } from "vitest";

// Mock environment variables for testing
process.env["NODE_ENV"] = "test";
process.env["DATABASE_URL"] =
  process.env["DATABASE_URL"] ??
  "postgresql://test:test@localhost:5432/buskinaticket_test";
process.env["REDIS_URL"] = process.env["REDIS_URL"] ?? "redis://localhost:6379";

// Test keys (generated for testing only — never use in production)
process.env["JWT_PRIVATE_KEY"] =
  process.env["JWT_PRIVATE_KEY"] ??
  "-----BEGIN RSA PRIVATE KEY-----\ntest_placeholder\n-----END RSA PRIVATE KEY-----";
process.env["JWT_PUBLIC_KEY"] =
  process.env["JWT_PUBLIC_KEY"] ??
  "-----BEGIN PUBLIC KEY-----\ntest_placeholder\n-----END PUBLIC KEY-----";
process.env["QR_SIGNING_PRIVATE_KEY"] =
  process.env["QR_SIGNING_PRIVATE_KEY"] ??
  "-----BEGIN EC PRIVATE KEY-----\ntest_placeholder\n-----END EC PRIVATE KEY-----";
process.env["QR_SIGNING_PUBLIC_KEY"] =
  process.env["QR_SIGNING_PUBLIC_KEY"] ??
  "-----BEGIN PUBLIC KEY-----\ntest_placeholder\n-----END PUBLIC KEY-----";

// Reset all mocks between tests
vi.clearAllMocks();
