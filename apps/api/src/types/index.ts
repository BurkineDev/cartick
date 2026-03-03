/**
 * Shared TypeScript types for BuskinaTicket API
 */
import type { UserRole } from "@buskinaticket/database";

// JWT payload claims
export interface JwtPayload {
  sub: string;        // user_id
  company_id: string | null;
  role: UserRole;
  device_id?: string;
  ip_hash?: string;
  type: "access" | "refresh";
}

// Standard API error response
export interface ApiError {
  error: string;
  code: string;
  details?: Record<string, unknown>;
}

// Standard paginated response (cursor-based)
export interface PaginatedResponse<T> {
  data: T[];
  cursor: string | null;
  has_more: boolean;
}

// Seat status transitions allowed
export const SEAT_TRANSITIONS = {
  free: ["hold", "paid"],        // hold = online, paid = cash sale
  hold: ["paid", "free"],        // paid = payment confirmed, free = expired
  paid: ["boarded", "cancelled", "no_show"],
  checked_in: ["boarded"],
  boarded: [],                   // Terminal state
  cancelled: ["free"],           // After refund validation
  no_show: [],                   // Terminal state
} as const;

// QR code payload structure (JWT claims)
export interface QrPayload {
  iss: string;   // "buskinaticket.bf"
  iat: number;   // issued at
  jti: string;   // ticket UUID (unique identifier — anti-replay)
  dep: string;   // departure UUID
  seat: string;  // seat number e.g. "12A"
  pax: string;   // passenger name
  route: string; // e.g. "OUA-BBO"
  dt: string;    // departure datetime ISO8601
}

// Mobile Money operator names
export type MobileMoneyOperator = "orange_money" | "moov_money" | "wave";

// Webhook event types
export interface WebhookPayload {
  operator_ref: string;
  status: "success" | "failed" | "cancelled";
  amount: number;
  currency: string;
  timestamp: string;
}
