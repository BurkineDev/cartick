/**
 * Reporting Service — Réconciliation Financière Formelle
 *
 * Processus de clôture quotidienne:
 * 1. Agrégation automatique (digital + cash + embarquements)
 * 2. Détection des écarts (> 2% = flagué "disputed")
 * 3. Clôture avec signature électronique
 * 4. État "closed" = IMMUABLE
 */
import { prisma } from "@buskinaticket/database";

export class ReportingService {
  /**
   * Génère le rapport de réconciliation pour une date donnée
   * Agrège: ventes digitales + ventes cash + embarquements
   */
  async generateReconciliation(params: {
    companyId: string;
    date: Date;
  }): Promise<{
    totalDigitalSales: number;
    totalCashSales: number;
    totalPlatformFees: number;
    totalTicketsIssued: number;
    totalBoarded: number;
    disputedAmount: number;
    anomalies: string[];
  }> {
    const { companyId, date } = params;

    const startOfDay = new Date(date);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(date);
    endOfDay.setHours(23, 59, 59, 999);

    // Ventes digitales (Orange Money, Moov, Wave, Card)
    const digitalTxs = await prisma.transaction.aggregate({
      where: {
        payment_status: "paid",
        payment_mode: { in: ["orange_money", "moov_money", "wave", "card"] },
        created_at: { gte: startOfDay, lte: endOfDay },
        ticket: {
          seat: { departure: { company_id: companyId } },
        },
      },
      _sum: { amount: true, platform_fee: true },
      _count: { id: true },
    });

    // Ventes cash
    const cashTxs = await prisma.transaction.aggregate({
      where: {
        payment_status: "paid",
        payment_mode: "cash",
        created_at: { gte: startOfDay, lte: endOfDay },
        ticket: {
          seat: { departure: { company_id: companyId } },
        },
      },
      _sum: { amount: true, platform_fee: true },
      _count: { id: true },
    });

    // Passagers embarqués (via events)
    const boardedCount = await prisma.seatEvent.count({
      where: {
        event: "TICKET_BOARDED",
        created_at: { gte: startOfDay, lte: endOfDay },
        seat: { departure: { company_id: companyId } },
      },
    });

    // Billets émis
    const ticketsIssued = await prisma.ticket.count({
      where: {
        issued_at: { gte: startOfDay, lte: endOfDay },
        seat: { departure: { company_id: companyId } },
        invalidated_at: null,
      },
    });

    const totalDigital = Number(digitalTxs._sum.amount ?? 0);
    const totalCash = Number(cashTxs._sum.amount ?? 0);
    const totalFees =
      Number(digitalTxs._sum.platform_fee ?? 0) +
      Number(cashTxs._sum.platform_fee ?? 0);
    const totalSales = totalDigital + totalCash;

    // Détection d'anomalies
    const anomalies: string[] = [];
    let disputedAmount = 0;

    // Écart entre billets émis et transactions payées
    const paidTxCount =
      (digitalTxs._count.id ?? 0) + (cashTxs._count.id ?? 0);
    if (ticketsIssued !== paidTxCount) {
      anomalies.push(
        `Écart tickets/transactions: ${ticketsIssued} billets émis vs ${paidTxCount} transactions paid`
      );
    }

    // Taux d'écart global (> 2% = disputed)
    if (totalSales > 0) {
      const discrepancyRate = Math.abs(ticketsIssued - boardedCount) / ticketsIssued;
      if (discrepancyRate > 0.02) {
        const discrepancyAmount = totalSales * discrepancyRate;
        disputedAmount = discrepancyAmount;
        anomalies.push(
          `Écart ventes/embarquements: ${(discrepancyRate * 100).toFixed(1)}% (${discrepancyAmount.toFixed(0)} XOF)`
        );
      }
    }

    return {
      totalDigitalSales: totalDigital,
      totalCashSales: totalCash,
      totalPlatformFees: totalFees,
      totalTicketsIssued: ticketsIssued,
      totalBoarded: boardedCount,
      disputedAmount,
      anomalies,
    };
  }

  /**
   * Crée ou met à jour la réconciliation du jour (état "open")
   */
  async upsertDailyReconciliation(params: {
    companyId: string;
    date: Date;
  }) {
    const data = await this.generateReconciliation(params);
    const { companyId, date } = params;

    const closingDate = new Date(date);
    closingDate.setHours(0, 0, 0, 0);

    return prisma.dailyReconciliation.upsert({
      where: {
        company_id_closing_date: {
          company_id: companyId,
          closing_date: closingDate,
        },
      },
      update: {
        total_digital_sales: data.totalDigitalSales,
        total_cash_sales: data.totalCashSales,
        total_platform_fees: data.totalPlatformFees,
        total_tickets_issued: data.totalTicketsIssued,
        total_boarded: data.totalBoarded,
        disputed_amount: data.disputedAmount,
        status: data.anomalies.length > 0 ? "disputed" : "open",
        notes: data.anomalies.join("\n"),
      },
      create: {
        company_id: companyId,
        closing_date: closingDate,
        status: data.anomalies.length > 0 ? "disputed" : "open",
        total_digital_sales: data.totalDigitalSales,
        total_cash_sales: data.totalCashSales,
        total_platform_fees: data.totalPlatformFees,
        total_tickets_issued: data.totalTicketsIssued,
        total_boarded: data.totalBoarded,
        disputed_amount: data.disputedAmount,
        notes: data.anomalies.length > 0 ? data.anomalies.join("\n") : null,
      },
    });
  }

  /**
   * Clôture définitive de la journée comptable
   * État "closed" = IMMUABLE après cette opération
   */
  async closeReconciliation(params: {
    companyId: string;
    date: Date;
    closedBy: string;
    notes?: string;
  }): Promise<void> {
    const { companyId, date, closedBy, notes } = params;
    const closingDate = new Date(date);
    closingDate.setHours(0, 0, 0, 0);

    const existing = await prisma.dailyReconciliation.findUnique({
      where: {
        company_id_closing_date: {
          company_id: companyId,
          closing_date: closingDate,
        },
      },
    });

    if (!existing) {
      // Auto-générer si pas encore créée
      await this.upsertDailyReconciliation({ companyId, date });
    }

    // Vérifier qu'elle n'est pas déjà clôturée
    const current = await prisma.dailyReconciliation.findUnique({
      where: {
        company_id_closing_date: {
          company_id: companyId,
          closing_date: closingDate,
        },
      },
    });

    if (current?.status === "closed") {
      throw new Error("Reconciliation already closed — immutable");
    }

    // Marquer les transactions comme réconciliées
    await prisma.transaction.updateMany({
      where: {
        payment_status: "paid",
        reconciled: false,
        created_at: {
          gte: closingDate,
          lt: new Date(closingDate.getTime() + 24 * 60 * 60 * 1000),
        },
        ticket: { seat: { departure: { company_id: companyId } } },
      },
      data: {
        reconciled: true,
        reconciliation_date: closingDate,
      },
    });

    // Clôturer — état IMMUABLE
    await prisma.dailyReconciliation.update({
      where: {
        company_id_closing_date: {
          company_id: companyId,
          closing_date: closingDate,
        },
      },
      data: {
        status: "closed",
        closed_by: closedBy,
        closed_at: new Date(),
        notes: notes ?? current?.notes,
      },
    });

    // Audit log de la clôture
    await prisma.auditLog.create({
      data: {
        user_id: closedBy,
        action: "RECONCILIATION_CLOSED",
        resource: "daily_reconciliation",
        data: {
          company_id: companyId,
          closing_date: closingDate.toISOString(),
        },
      },
    });
  }

  /**
   * Rapport de ventes personnel d'un agent
   */
  async getAgentSalesReport(params: {
    agentId: string;
    date: Date;
  }) {
    const { agentId, date } = params;
    const startOfDay = new Date(date);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(date);
    endOfDay.setHours(23, 59, 59, 999);

    const [cashSales, cancellations] = await Promise.all([
      prisma.transaction.findMany({
        where: {
          agent_id: agentId,
          payment_mode: "cash",
          payment_status: "paid",
          created_at: { gte: startOfDay, lte: endOfDay },
        },
        include: {
          ticket: {
            select: {
              passenger_name: true,
              seat: {
                select: {
                  seat_number: true,
                  departure: {
                    include: {
                      route: {
                        include: { origin_city: true, destination_city: true },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        orderBy: { created_at: "desc" },
      }),
      prisma.seatEvent.count({
        where: {
          event: "TICKET_CANCELLED",
          created_at: { gte: startOfDay, lte: endOfDay },
          data: { path: ["requester_id"], equals: agentId },
        },
      }),
    ]);

    const totalAmount = cashSales.reduce(
      (sum, tx) => sum + Number(tx.amount),
      0
    );

    return {
      date: startOfDay.toISOString().split("T")[0],
      agent_id: agentId,
      sales_count: cashSales.length,
      total_amount: totalAmount,
      cancellations_count: cancellations,
      sales: cashSales,
    };
  }
}
