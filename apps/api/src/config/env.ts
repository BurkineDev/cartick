/**
 * Environment configuration with validation
 * All secrets must come from environment — never hardcoded
 */
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default("0.0.0.0"),

  // Database
  DATABASE_URL: z.string().url(),

  // Redis
  REDIS_URL: z.string().default("redis://localhost:6379"),

  // JWT — RS256 asymmetric keys
  JWT_PRIVATE_KEY: z.string(), // PEM format
  JWT_PUBLIC_KEY: z.string(),  // PEM format
  JWT_ACCESS_TOKEN_TTL: z.string().default("15m"),
  JWT_REFRESH_TOKEN_TTL: z.string().default("7d"),

  // ECDSA P-256 for QR code signing
  QR_SIGNING_PRIVATE_KEY: z.string(), // PEM format
  QR_SIGNING_PUBLIC_KEY: z.string(),  // PEM format

  // Mobile Money
  ORANGE_MONEY_API_URL: z.string().url().optional(),
  ORANGE_MONEY_CLIENT_ID: z.string().optional(),
  ORANGE_MONEY_CLIENT_SECRET: z.string().optional(),
  ORANGE_MONEY_WEBHOOK_SECRET: z.string().optional(),
  ORANGE_MONEY_IPS: z.string().default(""), // Comma-separated

  MOOV_MONEY_API_URL: z.string().url().optional(),
  MOOV_MONEY_API_KEY: z.string().optional(),
  MOOV_MONEY_WEBHOOK_SECRET: z.string().optional(),
  MOOV_MONEY_IPS: z.string().default(""),

  WAVE_API_URL: z.string().url().optional(),
  WAVE_API_KEY: z.string().optional(),
  WAVE_WEBHOOK_SECRET: z.string().optional(),
  WAVE_IPS: z.string().default(""),

  // SMS / WhatsApp
  AFRICAS_TALKING_API_KEY: z.string().optional(),
  AFRICAS_TALKING_USERNAME: z.string().optional(),
  AFRICAS_TALKING_SENDER_ID: z.string().default("BuskinaTicket"),

  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_PHONE_NUMBER: z.string().optional(),
  TWILIO_WHATSAPP_NUMBER: z.string().optional(),

  // Application
  APP_DOMAIN: z.string().default("buskinaticket.bf"),
  API_BASE_URL: z.string().default("https://api.buskinaticket.bf"),
  SMS_BASE_URL: z.string().default("https://sms.buskinaticket.bf"),

  // Cors
  CORS_ORIGINS: z.string().default("http://localhost:3001,http://localhost:3002"),
});

function parseEnv() {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error(
      "❌ Invalid environment configuration:\n",
      result.error.flatten().fieldErrors
    );
    process.exit(1);
  }
  return result.data;
}

export const env = parseEnv();
export type Env = typeof env;
