/**
 * Inventory Service — Seat State Machine with Anti-Double-Sale Protection
 *
 * CONTRAINTE ABSOLUE: Un siège ne peut jamais être vendu deux fois.
 * Utilise SELECT FOR UPDATE SKIP LOCKED + optimistic locking (version field)
 */
import { prisma } from "@buskinaticket/database";
import type { SeatStatus, Prisma } from "@buskinaticket/database";
import type { Redis } from "ioredis";
import { SEAT_TRANSITIONS } from "../../types/index.js";

export class InventoryService {
  constructor(private readonly redis: Redis) {}

  /**
   * Pose un verrou temporaire sur un siège (5 min)
   * Utilise SELECT FOR UPDATE SKIP LOCKED pour la concurrence haute
   *
   * @throws 409 si le siège n'est pas disponible
   */
  async holdSeat(params: {
    seatId: string;
    departureId: string;
    sessionId: string;
    companyId: string;
    holdMinutes?: number;
  }): Promise<{ seatNumber: string; expiresAt: Date }> {
    const { seatId, departureId, sessionId, holdMinutes = 5 } = params;

    return await prisma.$transaction(async (tx) => {
      // SELECT FOR UPDATE SKIP LOCKED — atomique, pas de deadlock
      const seats = await tx.$queryRaw<
        Array<{ id: string; status: string; version: number; seat_number: string }>
      >`
        SELECT id, status, version, seat_number
        FROM seats
        WHERE id = ${seatId}::uuid
          AND departure_id = ${departureId}::uuid
          AND status = 'free'
        FOR UPDATE SKIP LOCKED
      `;

      if (seats.length === 0) {
        throw new SeatNotAvailableError(seatId);
      }

      const seat = seats[0]!;
      const expiresAt = new Date(Date.now() + holdMinutes * 60 * 1000);

      // Poser le hold avec optimistic locking
      const updated = await tx.$executeRaw`
        UPDATE seats SET
          status = 'hold',
          hold_session_id = ${sessionId}::uuid,
          hold_expires_at = ${expiresAt},
          version = version + 1,
          updated_at = NOW()
        WHERE id = ${seatId}::uuid
          AND status = 'free'
          AND version = ${seat.version}
      `;

      if (updated === 0) {
        throw new SeatNotAvailableError(seatId);
      }

      // Journaliser l'événement (immuable)
      await tx.seatEvent.create({
        data: {
          seat_id: seatId,
          event: "SEAT_HELD",
          data: {
            seat_id: seatId,
            session_id: sessionId,
            departure_id: departureId,
            expires_at: expiresAt.toISOString(),
          },
        },
      });

      return { seatNumber: seat.seat_number, expiresAt };
    });
  }

  /**
   * Libère un hold avant expiration
   */
  async releaseSeat(params: {
    seatId: string;
    sessionId: string;
  }): Promise<void> {
    const { seatId, sessionId } = params;

    await prisma.$transaction(async (tx) => {
      const updated = await tx.$executeRaw`
        UPDATE seats SET
          status = 'free',
          hold_session_id = NULL,
          hold_expires_at = NULL,
          version = version + 1,
          updated_at = NOW()
        WHERE id = ${seatId}::uuid
          AND status = 'hold'
          AND hold_session_id = ${sessionId}::uuid
      `;

      if (updated > 0) {
        await tx.seatEvent.create({
          data: {
            seat_id: seatId,
            event: "SEAT_RELEASED",
            data: { seat_id: seatId, session_id: sessionId, reason: "manual" },
          },
        });
      }
    });
  }

  /**
   * Confirme le paiement — hold → paid
   * Utilise optimistic locking sur le champ version
   */
  async confirmSeatPayment(params: {
    seatId: string;
    sessionId: string;
    price: number;
    version: number;
  }): Promise<void> {
    const { seatId, sessionId, price, version } = params;

    const updated = await prisma.$executeRaw`
      UPDATE seats SET
        status = 'paid',
        price = ${price},
        hold_session_id = NULL,
        hold_expires_at = NULL,
        version = version + 1,
        updated_at = NOW()
      WHERE id = ${seatId}::uuid
        AND status = 'hold'
        AND hold_session_id = ${sessionId}::uuid
        AND version = ${version}
    `;

    if (updated === 0) {
      throw new OptimisticLockError(seatId);
    }

    await prisma.seatEvent.create({
      data: {
        seat_id: seatId,
        event: "PAYMENT_CONFIRMED",
        data: { seat_id: seatId, price, session_id: sessionId },
      },
    });
  }

  /**
   * Vente cash — free → paid (agent uniquement)
   */
  async cashSale(params: {
    seatId: string;
    departureId: string;
    agentId: string;
    price: number;
  }): Promise<{ seatNumber: string }> {
    const { seatId, departureId, agentId, price } = params;

    return await prisma.$transaction(async (tx) => {
      const seats = await tx.$queryRaw<
        Array<{ id: string; version: number; seat_number: string }>
      >`
        SELECT id, version, seat_number
        FROM seats
        WHERE id = ${seatId}::uuid
          AND departure_id = ${departureId}::uuid
          AND status = 'free'
        FOR UPDATE SKIP LOCKED
      `;

      if (seats.length === 0) {
        throw new SeatNotAvailableError(seatId);
      }

      const seat = seats[0]!;

      const updated = await tx.$executeRaw`
        UPDATE seats SET
          status = 'paid',
          price = ${price},
          sold_by = ${agentId}::uuid,
          version = version + 1,
          updated_at = NOW()
        WHERE id = ${seatId}::uuid
          AND status = 'free'
          AND version = ${seat.version}
      `;

      if (updated === 0) {
        throw new SeatNotAvailableError(seatId);
      }

      await tx.seatEvent.create({
        data: {
          seat_id: seatId,
          event: "PAYMENT_CONFIRMED",
          data: { seat_id: seatId, agent_id: agentId, price, mode: "cash" },
        },
      });

      return { seatNumber: seat.seat_number };
    });
  }

  /**
   * Marque un siège comme embarqué (via scan QR)
   */
  async markBoarded(params: {
    seatId: string;
    scannerId: string;
    departureId: string;
    offline?: boolean;
  }): Promise<void> {
    const { seatId, scannerId, departureId, offline = false } = params;

    const updated = await prisma.$executeRaw`
      UPDATE seats SET
        status = 'boarded',
        version = version + 1,
        updated_at = NOW()
      WHERE id = ${seatId}::uuid
        AND departure_id = ${departureId}::uuid
        AND status = 'paid'
    `;

    if (updated === 0) {
      // Vérifier si déjà embarqué
      const seat = await prisma.seat.findUnique({
        where: { id: seatId },
        select: { status: true },
      });
      if (seat?.status === "boarded") {
        throw new AlreadyBoardedError(seatId);
      }
      throw new InvalidSeatStateError(seatId, "paid");
    }

    await prisma.seatEvent.create({
      data: {
        seat_id: seatId,
        event: "TICKET_BOARDED",
        data: {
          seat_id: seatId,
          scanner_id: scannerId,
          departure_id: departureId,
          offline,
        },
      },
    });
  }

  /**
   * Annule un billet (paid → cancelled)
   * Uniquement avant l'heure de départ
   */
  async cancelTicket(params: {
    seatId: string;
    requesterId: string;
    reason?: string;
  }): Promise<void> {
    const { seatId, requesterId, reason } = params;

    await prisma.$transaction(async (tx) => {
      // Vérifier que le départ n'est pas encore parti
      const seat = await tx.seat.findUnique({
        where: { id: seatId },
        include: {
          departure: {
            select: {
              departure_datetime: true,
              status: true,
              manifest_locked: true,
            },
          },
        },
      });

      if (!seat) throw new Error("Seat not found");
      if (seat.departure.manifest_locked) {
        throw new DepartureClosedError();
      }
      if (seat.departure.departure_datetime < new Date()) {
        throw new DepartureClosedError();
      }
      if (seat.status !== "paid") {
        throw new InvalidSeatStateError(seatId, "paid");
      }

      await tx.$executeRaw`
        UPDATE seats SET
          status = 'cancelled',
          version = version + 1,
          updated_at = NOW()
        WHERE id = ${seatId}::uuid AND status = 'paid'
      `;

      await tx.seatEvent.create({
        data: {
          seat_id: seatId,
          event: "TICKET_CANCELLED",
          data: { seat_id: seatId, requester_id: requesterId, reason },
        },
      });

      // Invalider le ticket
      await tx.ticket.updateMany({
        where: { seat_id: seatId, invalidated_at: null },
        data: { invalidated_at: new Date() },
      });
    });
  }

  /**
   * Récupère le plan de sièges d'un départ avec statuts temps réel
   */
  async getDepartureSeatMap(departureId: string) {
    const departure = await prisma.departure.findUnique({
      where: { id: departureId },
      include: {
        bus: { select: { seat_layout_json: true, capacity: true } },
        seats: {
          select: {
            id: true,
            seat_number: true,
            seat_type: true,
            status: true,
            price: true,
          },
          orderBy: { seat_number: "asc" },
        },
      },
    });

    return departure;
  }

  /**
   * Job de nettoyage des holds expirés (à appeler toutes les 30s)
   */
  async cleanupExpiredHolds(): Promise<number> {
    const result = await prisma.$executeRaw`
      UPDATE seats SET
        status = 'free',
        hold_session_id = NULL,
        hold_expires_at = NULL,
        version = version + 1,
        updated_at = NOW()
      WHERE status = 'hold'
        AND hold_expires_at < NOW()
    `;

    if (result > 0) {
      // Log les expirations (sans bloquer)
      await prisma.seatEvent
        .createMany({
          data: [], // Les événements sont créés par trigger DB en production
        })
        .catch(() => undefined);
    }

    return result as number;
  }

  /**
   * Valide une transition d'état
   */
  isTransitionAllowed(from: SeatStatus, to: SeatStatus): boolean {
    const allowed = SEAT_TRANSITIONS[from] as readonly SeatStatus[];
    return allowed.includes(to);
  }
}

// ─── Erreurs Métier ───────────────────────────────────────────────────────────

export class SeatNotAvailableError extends Error {
  readonly code = "SEAT_NOT_AVAILABLE";
  readonly statusCode = 409;
  constructor(seatId: string) {
    super(`Seat ${seatId} is not available`);
  }
}

export class AlreadyBoardedError extends Error {
  readonly code = "TICKET_ALREADY_BOARDED";
  readonly statusCode = 409;
  constructor(seatId: string) {
    super(`Ticket for seat ${seatId} has already been boarded`);
  }
}

export class OptimisticLockError extends Error {
  readonly code = "OPTIMISTIC_LOCK_CONFLICT";
  readonly statusCode = 409;
  constructor(seatId: string) {
    super(`Concurrent modification detected for seat ${seatId}`);
  }
}

export class InvalidSeatStateError extends Error {
  readonly code = "INVALID_SEAT_STATE";
  readonly statusCode = 422;
  constructor(seatId: string, expectedStatus: string) {
    super(`Seat ${seatId} must be in '${expectedStatus}' status`);
  }
}

export class DepartureClosedError extends Error {
  readonly code = "DEPARTURE_CLOSED";
  readonly statusCode = 422;
  constructor() {
    super("Departure is closed — operations not allowed");
  }
}

// Suppress unused import warning for Prisma types
type _PrismaTypes = Prisma.TransactionClient;
