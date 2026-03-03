/**
 * Payment Service — Mobile Money + Cash
 *
 * Gestion complète des états de paiement:
 * pending → processing → paid | failed | expired | disputed | refunded
 *
 * Principe d'idempotence: chaque requête porte un X-Idempotency-Key
 */
import { prisma } from "@buskinaticket/database";
import type { PaymentMode } from "@buskinaticket/database";
import * as crypto from "crypto";
import type { Redis } from "ioredis";
import type { Queue } from "bullmq";
import { InventoryService } from "../inventory/inventory.service.js";

const IDEMPOTENCY_TTL = 24 * 60 * 60; // 24h in seconds

export class PaymentService {
  private readonly inventoryService: InventoryService;

  constructor(
    private readonly redis: Redis,
    private readonly paymentQueue: Queue
  ) {
    this.inventoryService = new InventoryService(redis);
  }

  /**
   * Initie un paiement Mobile Money
   * Idempotent via X-Idempotency-Key
   */
  async initiatePayment(params: {
    idempotencyKey: string;
    seatId: string;
    sessionId: string;
    amount: number;
    mode: PaymentMode;
    customerPhone: string;
    ticketData: {
      passengerName: string;
      passengerPhone: string;
      deliveryMethod: "sms" | "whatsapp" | "print" | "app";
    };
  }): Promise<{
    transactionId: string;
    status: string;
    operatorRef?: string;
  }> {
    const { idempotencyKey, seatId } = params;

    // Idempotence check — Redis cache
    const cached = await this.redis.get(`idempotency:${idempotencyKey}`);
    if (cached) {
      return JSON.parse(cached) as {
        transactionId: string;
        status: string;
        operatorRef?: string;
      };
    }

    // Récupérer la seat avec le ticket existant ou créer
    const seat = await prisma.seat.findUnique({
      where: { id: seatId },
      include: {
        departure: {
          include: {
            route: { select: { base_price: true, vip_price: true, code: true } },
          },
        },
        ticket: true,
      },
    });

    if (!seat) throw new Error("Seat not found");
    if (seat.status !== "hold") throw new Error("Seat is not on hold");

    // Enqueue payment processing
    const jobData = {
      idempotencyKey,
      seatId,
      sessionId: params.sessionId,
      amount: params.amount,
      mode: params.mode,
      customerPhone: params.customerPhone,
      ticketData: params.ticketData,
      departureId: seat.departure_id,
    };

    const job = await this.paymentQueue.add("initiate-payment", jobData, {
      jobId: idempotencyKey, // BullMQ dedup
      attempts: 3,
      backoff: { type: "exponential", delay: 1000 },
    });

    const result = {
      transactionId: job.id ?? idempotencyKey,
      status: "pending",
    };

    // Cache pour idempotence (24h)
    await this.redis.setex(
      `idempotency:${idempotencyKey}`,
      IDEMPOTENCY_TTL,
      JSON.stringify(result)
    );

    return result;
  }

  /**
   * Récupère le statut d'un paiement
   */
  async getPaymentStatus(transactionId: string) {
    const transaction = await prisma.transaction.findUnique({
      where: { id: transactionId },
      select: {
        id: true,
        payment_status: true,
        payment_mode: true,
        amount: true,
        operator_ref: true,
        created_at: true,
        updated_at: true,
      },
    });

    return transaction;
  }

  /**
   * Traite un webhook Mobile Money entrant
   * HMAC-SHA256 validé avant d'arriver ici
   */
  async processWebhook(params: {
    operatorRef: string;
    status: "success" | "failed" | "cancelled";
    amount: number;
    idempotencyKey: string;
  }): Promise<void> {
    const { operatorRef, status, amount, idempotencyKey } = params;

    // Idempotence check via Redis
    const webhookKey = `webhook:${operatorRef}`;
    const alreadyProcessed = await this.redis.exists(webhookKey);
    if (alreadyProcessed) return; // Doublon — ignorer silencieusement

    // Marquer comme traité
    await this.redis.setex(webhookKey, IDEMPOTENCY_TTL, "1");

    // Enqueue traitement asynchrone (pas de traitement synchrone)
    await this.paymentQueue.add(
      "process-webhook",
      { operatorRef, status, amount, idempotencyKey },
      {
        jobId: `webhook:${operatorRef}`,
        attempts: 5,
        backoff: { type: "exponential", delay: 2000 },
      }
    );
  }

  /**
   * Vente cash agent avec idempotence
   */
  async processCashSale(params: {
    idempotencyKey: string;
    seatId: string;
    departureId: string;
    agentId: string;
    amount: number;
    companyId: string;
    passengerName: string;
    passengerPhone: string;
    deliveryMethod: "sms" | "whatsapp" | "print" | "app";
    platformFeeRate?: number;
  }): Promise<{
    ticketId: string;
    seatNumber: string;
    transactionId: string;
  }> {
    const { idempotencyKey } = params;

    // Idempotence check
    const cached = await this.redis.get(`idempotency:${idempotencyKey}`);
    if (cached) {
      return JSON.parse(cached) as {
        ticketId: string;
        seatNumber: string;
        transactionId: string;
      };
    }

    // Atomic: sell seat + create ticket + create transaction
    const result = await prisma.$transaction(async (tx) => {
      // Cash sale — atomique avec SELECT FOR UPDATE
      const { seatNumber } = await this.inventoryService.cashSale({
        seatId: params.seatId,
        departureId: params.departureId,
        agentId: params.agentId,
        price: params.amount,
      });

      // Create ticket placeholder (QR généré dans le module ticketing)
      const ticket = await tx.ticket.create({
        data: {
          seat_id: params.seatId,
          passenger_name: params.passengerName,
          passenger_phone_hash: hashPhone(params.passengerPhone),
          qr_code: "", // Rempli par le service ticketing
          qr_signature: "",
          delivery_method: params.deliveryMethod,
          delivery_status: "pending",
        },
      });

      const platformFee =
        params.amount * (params.platformFeeRate ?? 0.03);

      const transaction = await tx.transaction.create({
        data: {
          idempotency_key: idempotencyKey,
          ticket_id: ticket.id,
          payment_mode: "cash",
          payment_status: "paid",
          amount: params.amount,
          platform_fee: platformFee,
          agent_id: params.agentId,
        },
      });

      return { ticketId: ticket.id, seatNumber, transactionId: transaction.id };
    });

    // Enqueue QR generation + delivery
    await this.paymentQueue.add("generate-and-deliver-ticket", {
      ticketId: result.ticketId,
      passengerPhone: params.passengerPhone,
      deliveryMethod: params.deliveryMethod,
    });

    // Cache idempotence
    await this.redis.setex(
      `idempotency:${idempotencyKey}`,
      IDEMPOTENCY_TTL,
      JSON.stringify(result)
    );

    return result;
  }
}

function hashPhone(phone: string): string {
  return crypto.createHash("sha256").update(phone.trim()).digest("hex");
}
