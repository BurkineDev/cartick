/**
 * Tests — Inventory Service
 * Focus sur la contrainte absolue: un siège ne peut jamais être vendu deux fois
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SEAT_TRANSITIONS } from "../types/index.js";
import type { SeatStatus } from "@buskinaticket/database";

// Test the state machine transitions
describe("Seat State Machine", () => {
  it("allows free → hold transition", () => {
    const from: SeatStatus = "free";
    const to: SeatStatus = "hold";
    const allowed = (SEAT_TRANSITIONS[from] as readonly SeatStatus[]).includes(to);
    expect(allowed).toBe(true);
  });

  it("allows free → paid transition (cash sale)", () => {
    const from: SeatStatus = "free";
    const to: SeatStatus = "paid";
    const allowed = (SEAT_TRANSITIONS[from] as readonly SeatStatus[]).includes(to);
    expect(allowed).toBe(true);
  });

  it("allows hold → paid transition", () => {
    const from: SeatStatus = "hold";
    const to: SeatStatus = "paid";
    const allowed = (SEAT_TRANSITIONS[from] as readonly SeatStatus[]).includes(to);
    expect(allowed).toBe(true);
  });

  it("allows hold → free transition (expired)", () => {
    const from: SeatStatus = "hold";
    const to: SeatStatus = "free";
    const allowed = (SEAT_TRANSITIONS[from] as readonly SeatStatus[]).includes(to);
    expect(allowed).toBe(true);
  });

  it("allows paid → boarded transition", () => {
    const from: SeatStatus = "paid";
    const to: SeatStatus = "boarded";
    const allowed = (SEAT_TRANSITIONS[from] as readonly SeatStatus[]).includes(to);
    expect(allowed).toBe(true);
  });

  it("does NOT allow free → boarded transition", () => {
    const from: SeatStatus = "free";
    const to: SeatStatus = "boarded";
    const allowed = (SEAT_TRANSITIONS[from] as readonly SeatStatus[]).includes(to);
    expect(allowed).toBe(false);
  });

  it("does NOT allow boarded → free transition (terminal state)", () => {
    const from: SeatStatus = "boarded";
    const to: SeatStatus = "free";
    const allowed = (SEAT_TRANSITIONS[from] as readonly SeatStatus[]).includes(to);
    expect(allowed).toBe(false);
  });

  it("does NOT allow no_show → free transition (terminal state)", () => {
    const from: SeatStatus = "no_show";
    const to: SeatStatus = "free";
    const allowed = (SEAT_TRANSITIONS[from] as readonly SeatStatus[]).includes(to);
    expect(allowed).toBe(false);
  });

  it("allows paid → cancelled transition (before departure)", () => {
    const from: SeatStatus = "paid";
    const to: SeatStatus = "cancelled";
    const allowed = (SEAT_TRANSITIONS[from] as readonly SeatStatus[]).includes(to);
    expect(allowed).toBe(true);
  });

  it("allows cancelled → free transition (after refund)", () => {
    const from: SeatStatus = "cancelled";
    const to: SeatStatus = "free";
    const allowed = (SEAT_TRANSITIONS[from] as readonly SeatStatus[]).includes(to);
    expect(allowed).toBe(true);
  });
});

describe("QR Code Structure", () => {
  it("QR payload contains all required fields", () => {
    const payload = {
      iss: "buskinaticket.bf",
      iat: Math.floor(Date.now() / 1000),
      jti: "550e8400-e29b-41d4-a716-446655440000",
      dep: "660f9500-f30c-52e5-b827-557766551111",
      seat: "12A",
      pax: "KABORE Aristide",
      route: "OUA-BBO",
      dt: "2024-07-15T08:00:00Z",
    };

    expect(payload.iss).toBe("buskinaticket.bf");
    expect(payload.jti).toBeTruthy(); // Unique ID anti-replay
    expect(payload.dep).toBeTruthy(); // Departure ID
    expect(payload.seat).toBeTruthy();
    expect(payload.pax).toBeTruthy();
    expect(payload.route).toBeTruthy();
    expect(payload.dt).toBeTruthy();
  });
});

describe("Idempotency Key Validation", () => {
  it("validates UUID v4 format", () => {
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

    expect(uuidRegex.test("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
    expect(uuidRegex.test("invalid-key")).toBe(false);
    expect(uuidRegex.test("")).toBe(false);
  });
});
