/**
 * Cleanup Jobs — Expired holds, payment polling, reconciliation alerts
 */
import { Worker } from "bullmq";
import type { Queue } from "bullmq";
import { prisma } from "@buskinaticket/database";
import { InventoryService } from "../modules/inventory/inventory.service.js";
import type { Redis } from "ioredis";

/**
 * Job de nettoyage des holds expirés (toutes les 30s)
 */
export function createHoldCleanupJob(redis: Redis): NodeJS.Timeout {
  const inventoryService = new InventoryService(redis);

  return setInterval(async () => {
    try {
      const cleaned = await inventoryService.cleanupExpiredHolds();
      if (cleaned > 0) {
        console.info(`[HoldCleanup] Released ${cleaned} expired hold(s)`);
      }
    } catch (err) {
      console.error("[HoldCleanup] Error:", err);
    }
  }, 30_000); // 30 secondes
}

/**
 * Worker de traitement des webhooks Mobile Money
 */
export function createPaymentWorker(
  paymentQueue: Queue,
  redis: Redis
): Worker {
  return new Worker(
    "payment",
    async (job) => {
      if (job.name === "process-webhook") {
        const { operatorRef, status, amount } = job.data as {
          operatorRef: string;
          status: string;
          amount: number;
          idempotencyKey: string;
        };

        // Trouver la transaction par operator_ref
        const transaction = await prisma.transaction.findFirst({
          where: { operator_ref: operatorRef },
          include: {
            ticket: {
              include: {
                seat: {
                  select: {
                    id: true,
                    status: true,
                    hold_session_id: true,
                    version: true,
                    departure_id: true,
                  },
                },
              },
            },
          },
        });

        if (!transaction) {
          console.warn(
            `[PaymentWorker] Transaction not found for operator_ref: ${operatorRef}`
          );
          return;
        }

        if (status === "success") {
          // Vérifier le montant (alerte si différent)
          const expectedAmount = Number(transaction.amount);
          if (Math.abs(amount - expectedAmount) > 1) {
            await prisma.transaction.update({
              where: { id: transaction.id },
              data: {
                payment_status: "disputed",
                webhook_received_at: new Date(),
              },
            });
            console.warn(
              `[PaymentWorker] Amount mismatch for ${operatorRef}: expected ${expectedAmount}, got ${amount}`
            );
            return;
          }

          // Confirmer le paiement
          const inventoryService = new InventoryService(redis);

          if (transaction.ticket.seat.hold_session_id) {
            await inventoryService.confirmSeatPayment({
              seatId: transaction.ticket.seat.id,
              sessionId: transaction.ticket.seat.hold_session_id,
              price: amount,
              version: transaction.ticket.seat.version,
            });
          }

          await prisma.transaction.update({
            where: { id: transaction.id },
            data: {
              payment_status: "paid",
              webhook_received_at: new Date(),
            },
          });

          // Enqueue génération QR + delivery
          await paymentQueue.add("generate-and-deliver-ticket", {
            ticketId: transaction.ticket_id,
          });
        } else {
          // Paiement échoué/annulé → libérer le siège
          await prisma.transaction.update({
            where: { id: transaction.id },
            data: {
              payment_status: status === "cancelled" ? "failed" : "failed",
              webhook_received_at: new Date(),
            },
          });

          if (transaction.ticket.seat.hold_session_id) {
            const inventoryService = new InventoryService(redis);
            await inventoryService.releaseSeat({
              seatId: transaction.ticket.seat.id,
              sessionId: transaction.ticket.seat.hold_session_id,
            });
          }
        }
      }

      if (job.name === "generate-and-deliver-ticket") {
        const { ticketId, passengerPhone, deliveryMethod } = job.data as {
          ticketId: string;
          passengerPhone?: string;
          deliveryMethod?: string;
        };

        const { TicketingService } = await import(
          "../modules/ticketing/ticketing.service.js"
        );
        const ticketingService = new TicketingService();

        await ticketingService.finalizeTicket({
          ticketId,
          passengerPhone: passengerPhone ?? "",
          deliveryMethod: (deliveryMethod as "sms" | "whatsapp" | "print" | "app") ?? "sms",
        });
      }
    },
    {
      connection: redis,
      concurrency: 10,
    }
  );
}

/**
 * Alerte de réconciliation quotidienne (18h00)
 * Avertit les agents de la clôture à venir dans 2h
 */
export function createReconciliationAlertJob(redis: Redis): NodeJS.Timeout {
  return setInterval(async () => {
    const now = new Date();
    const hour = now.getHours();

    // 18h00 Burkina Faso (UTC+0 = UTC)
    if (hour === 18 && now.getMinutes() < 1) {
      try {
        const activeCompanies = await prisma.company.findMany({
          where: { is_active: true },
          select: { id: true, name: true },
        });

        for (const company of activeCompanies) {
          console.info(
            `[ReconciliationAlert] Sending 18h00 alert to company ${company.name}`
          );
          // TODO: Envoyer notification aux agents via WebSocket ou push notification
        }
      } catch (err) {
        console.error("[ReconciliationAlert] Error:", err);
      }
    }
  }, 60_000); // Vérifier toutes les minutes
}
