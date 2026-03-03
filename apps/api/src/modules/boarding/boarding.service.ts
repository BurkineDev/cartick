/**
 * Boarding Service — QR Scan + Verification (Online & Offline)
 *
 * Vérification offline: clé publique pré-chargée dans le scanner PWA
 * Anti-double-scan: cache LRU local (IndexedDB côté client) + Redis côté serveur
 */
import { prisma } from "@buskinaticket/database";
import { jwtVerify, importSPKI } from "jose";
import type { Redis } from "ioredis";
import { env } from "../../config/env.js";
import type { QrPayload } from "../../types/index.js";
import { InventoryService, AlreadyBoardedError } from "../inventory/inventory.service.js";

const SCANNED_QR_TTL = 24 * 60 * 60; // 24h en secondes
const SCANNED_QR_PREFIX = "scanned:";

export class BoardingService {
  private readonly inventoryService: InventoryService;

  constructor(private readonly redis: Redis) {
    this.inventoryService = new InventoryService(redis);
  }

  /**
   * Vérifie et enregistre l'embarquement
   * - Valide la signature ECDSA P-256
   * - Vérifie le departure_id (anti-reuse)
   * - Vérifie l'anti-doublon via Redis
   * - Marque le siège comme "boarded"
   */
  async verifyAndBoard(params: {
    qrPayload: string;
    scannerId: string;
    expectedDepartureId: string;
  }): Promise<{
    valid: boolean;
    passengerName?: string;
    seatNumber?: string;
    routeCode?: string;
    error?: string;
    code?: string;
  }> {
    const { qrPayload, scannerId, expectedDepartureId } = params;

    // 1. Vérifier la signature ECDSA P-256
    let payload: QrPayload;
    try {
      const publicKey = await importSPKI(env.QR_SIGNING_PUBLIC_KEY, "ES256");
      const { payload: verified } = await jwtVerify(qrPayload, publicKey, {
        issuer: "buskinaticket.bf",
      });
      payload = verified as unknown as QrPayload;
    } catch {
      return {
        valid: false,
        error: "Invalid QR signature",
        code: "INVALID_QR_SIGNATURE",
      };
    }

    // 2. Vérifier que le QR est pour ce départ (anti-reuse sur d'autres départs)
    if (payload.dep !== expectedDepartureId) {
      return {
        valid: false,
        error: "QR code is for a different departure",
        code: "QR_WRONG_DEPARTURE",
      };
    }

    // 3. Anti-double-scan via Redis (côté serveur)
    const scanKey = `${SCANNED_QR_PREFIX}${payload.jti}`;
    const alreadyScanned = await this.redis.exists(scanKey);
    if (alreadyScanned) {
      return {
        valid: false,
        error: "Ticket has already been scanned — potential fraud",
        code: "TICKET_ALREADY_BOARDED",
      };
    }

    // 4. Vérifier que le billet existe et est en état "paid"
    const ticket = await prisma.ticket.findUnique({
      where: { id: payload.jti },
      include: {
        seat: {
          select: {
            id: true,
            status: true,
            seat_number: true,
            departure_id: true,
          },
        },
      },
    });

    if (!ticket) {
      return {
        valid: false,
        error: "Ticket not found in system",
        code: "TICKET_NOT_FOUND",
      };
    }

    if (ticket.invalidated_at) {
      return {
        valid: false,
        error: "Ticket has been invalidated",
        code: "TICKET_INVALIDATED",
      };
    }

    if (ticket.seat.status === "boarded") {
      return {
        valid: false,
        error: "Ticket already boarded",
        code: "TICKET_ALREADY_BOARDED",
      };
    }

    if (ticket.seat.status !== "paid") {
      return {
        valid: false,
        error: `Ticket in invalid status: ${ticket.seat.status}`,
        code: "INVALID_TICKET_STATUS",
      };
    }

    // 5. Marquer comme embarqué
    try {
      await this.inventoryService.markBoarded({
        seatId: ticket.seat.id,
        scannerId,
        departureId: expectedDepartureId,
        offline: false,
      });
    } catch (err) {
      if (err instanceof AlreadyBoardedError) {
        return {
          valid: false,
          error: "Ticket already boarded",
          code: "TICKET_ALREADY_BOARDED",
        };
      }
      throw err;
    }

    // 6. Marquer dans Redis anti-doublon (TTL 24h)
    await this.redis.setex(scanKey, SCANNED_QR_TTL, scannerId);

    return {
      valid: true,
      passengerName: payload.pax,
      seatNumber: payload.seat,
      routeCode: payload.route,
    };
  }

  /**
   * Sync de la file d'attente offline (boardings enregistrés sans connexion)
   * Le premier synchronisé gagne — les doublons retournent une erreur
   */
  async syncOfflineQueue(params: {
    scannerId: string;
    boardings: Array<{
      qr_payload: string;
      departure_id: string;
      scanned_at: string;
    }>;
  }): Promise<{
    processed: number;
    conflicts: number;
    errors: Array<{ qr_payload: string; error: string }>;
  }> {
    let processed = 0;
    let conflicts = 0;
    const errors: Array<{ qr_payload: string; error: string }> = [];

    for (const boarding of params.boardings) {
      const result = await this.verifyAndBoard({
        qrPayload: boarding.qr_payload,
        scannerId: params.scannerId,
        expectedDepartureId: boarding.departure_id,
      });

      if (result.valid) {
        processed++;
      } else if (result.code === "TICKET_ALREADY_BOARDED") {
        conflicts++; // Premier synchronisé gagne
      } else {
        errors.push({
          qr_payload: boarding.qr_payload.slice(0, 20) + "...",
          error: result.error ?? "Unknown error",
        });
      }
    }

    return { processed, conflicts, errors };
  }

  /**
   * Récupère les données d'un départ pour le cache offline du scanner
   */
  async getDepartureForScanner(departureId: string, scannerId: string) {
    // Log l'accès scanner pour audit
    await prisma.auditLog.create({
      data: {
        user_id: scannerId,
        action: "SCANNER_CACHE_FETCH",
        resource: "departure",
        resource_id: departureId,
      },
    });

    const departure = await prisma.departure.findUnique({
      where: { id: departureId },
      include: {
        route: {
          include: { origin_city: true, destination_city: true },
        },
        bus: { select: { model: true, capacity: true } },
        seats: {
          where: { status: "paid" },
          include: {
            ticket: {
              select: {
                id: true,
                passenger_name: true,
                qr_code: false, // Ne pas exposer le QR complet dans le cache
              },
            },
          },
        },
      },
    });

    if (!departure) return null;

    // Retourner aussi la clé publique pour vérification offline
    return {
      departure,
      public_key: env.QR_SIGNING_PUBLIC_KEY,
    };
  }
}
