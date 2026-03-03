/**
 * Ticketing Service — QR Code Generation (JWT + ECDSA P-256) + Delivery
 *
 * Le QR code contient toutes les informations nécessaires à la vérification
 * cryptographique hors ligne via la clé publique pré-chargée dans le scanner.
 */
import { prisma } from "@buskinaticket/database";
import { SignJWT, importPKCS8 } from "jose";
import * as crypto from "crypto";
import { env } from "../../config/env.js";
import type { QrPayload } from "../../types/index.js";

export class TicketingService {
  /**
   * Génère un QR code JWT signé ECDSA P-256
   * Le payload contient toutes les infos nécessaires à la vérification offline
   */
  async generateQrCode(params: {
    ticketId: string;
    departureId: string;
    seatNumber: string;
    passengerName: string;
    routeCode: string;
    departureDatetime: Date;
  }): Promise<{ qrCode: string; signature: string }> {
    const privateKey = await importPKCS8(env.QR_SIGNING_PRIVATE_KEY, "ES256");

    const payload: QrPayload = {
      iss: "buskinaticket.bf",
      iat: Math.floor(Date.now() / 1000),
      jti: params.ticketId,
      dep: params.departureId,
      seat: params.seatNumber,
      pax: params.passengerName,
      route: params.routeCode,
      dt: params.departureDatetime.toISOString(),
    };

    const qrCode = await new SignJWT(payload as unknown as Record<string, unknown>)
      .setProtectedHeader({ alg: "ES256" })
      .setIssuer("buskinaticket.bf")
      .sign(privateKey);

    // Extraire la signature du JWT (dernière partie)
    const parts = qrCode.split(".");
    const signature = parts[2] ?? "";

    return { qrCode, signature };
  }

  /**
   * Met à jour le ticket avec le QR généré et enqueue la livraison
   */
  async finalizeTicket(params: {
    ticketId: string;
    passengerPhone: string;
    deliveryMethod: "sms" | "whatsapp" | "print" | "app";
  }): Promise<void> {
    const { ticketId, passengerPhone, deliveryMethod } = params;

    const ticket = await prisma.ticket.findUnique({
      where: { id: ticketId },
      include: {
        seat: {
          include: {
            departure: {
              include: {
                route: { select: { code: true } },
              },
            },
          },
        },
      },
    });

    if (!ticket) throw new Error(`Ticket ${ticketId} not found`);

    const { qrCode, signature } = await this.generateQrCode({
      ticketId,
      departureId: ticket.seat.departure_id,
      seatNumber: ticket.seat.seat_number,
      passengerName: ticket.passenger_name,
      routeCode: ticket.seat.departure.route.code,
      departureDatetime: ticket.seat.departure.departure_datetime,
    });

    await prisma.ticket.update({
      where: { id: ticketId },
      data: {
        qr_code: qrCode,
        qr_signature: signature,
      },
    });

    // Enqueue delivery (SMS, WhatsApp, etc.)
    await this.enqueueDelivery({
      ticketId,
      passengerPhone,
      deliveryMethod,
      qrCode,
    });
  }

  /**
   * Génère l'URL courte pour le SMS (SMS ne peut pas contenir l'image QR)
   * sms.buskinaticket.bf/T/XXXX → page légère avec QR
   */
  generateShortUrl(ticketId: string): string {
    // Encode les 8 premiers chars de l'UUID en base62
    const shortCode = ticketId.replace(/-/g, "").slice(0, 8).toUpperCase();
    return `${env.SMS_BASE_URL}/T/${shortCode}`;
  }

  private async enqueueDelivery(params: {
    ticketId: string;
    passengerPhone: string;
    deliveryMethod: string;
    qrCode: string;
  }) {
    // Dans un vrai système, on enqueue dans BullMQ
    // Pour l'instant, on marque juste en pending (le worker gérera)
    await prisma.ticket.update({
      where: { id: params.ticketId },
      data: { delivery_status: "pending" },
    });
  }

  /**
   * Renvoi du QR sur demande (cas Mobile Money confirmé mais SMS non reçu)
   */
  async resendTicket(params: {
    ticketId: string;
    passengerPhone: string;
    method?: "sms" | "whatsapp";
  }): Promise<void> {
    const ticket = await prisma.ticket.findUnique({
      where: { id: params.ticketId },
      select: {
        qr_code: true,
        delivery_method: true,
        invalidated_at: true,
        passenger_phone_hash: true,
      },
    });

    if (!ticket) throw new Error("Ticket not found");
    if (ticket.invalidated_at) throw new Error("Ticket is invalidated");
    if (!ticket.qr_code) throw new Error("Ticket QR not yet generated");

    // Vérifier le propriétaire via hash téléphone
    const phoneHash = crypto
      .createHash("sha256")
      .update(params.passengerPhone)
      .digest("hex");

    if (phoneHash !== ticket.passenger_phone_hash) {
      throw new Error("Phone number does not match ticket");
    }

    // Enqueue resend
    await this.enqueueDelivery({
      ticketId: params.ticketId,
      passengerPhone: params.passengerPhone,
      deliveryMethod: params.method ?? ticket.delivery_method,
      qrCode: ticket.qr_code,
    });

    await prisma.ticket.update({
      where: { id: params.ticketId },
      data: { delivery_status: "pending" },
    });
  }
}
