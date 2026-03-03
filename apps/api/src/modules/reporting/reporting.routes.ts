/**
 * Reporting Routes — Financial reports, reconciliation, agent reports
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ReportingService } from "./reporting.service.js";
import { requirePermission, requireRole } from "../auth/rbac.js";

export async function reportingRoutes(app: FastifyInstance) {
  const reportingService = new ReportingService();

  // GET /company/financial-report
  app.get(
    "/company/financial-report",
    {
      onRequest: [app.authenticate, requirePermission("view_company_financial")],
    },
    async (request, reply) => {
      const query = z
        .object({
          start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          format: z.enum(["json", "csv"]).default("json"),
        })
        .safeParse(request.query);

      if (!query.success) {
        return reply.status(400).send({
          error: "Invalid query parameters",
          code: "VALIDATION_ERROR",
          details: query.error.flatten().fieldErrors,
        });
      }

      const companyId = request.user.company_id;
      if (!companyId) {
        return reply.status(403).send({ error: "No company", code: "NO_COMPANY" });
      }

      const startDate = new Date(query.data.start_date);
      const endDate = new Date(query.data.end_date);

      // Récupérer les réconciliations de la période
      const reconciliations = await app.prisma.dailyReconciliation.findMany({
        where: {
          company_id: companyId,
          closing_date: { gte: startDate, lte: endDate },
        },
        orderBy: { closing_date: "asc" },
      });

      if (query.data.format === "csv") {
        const csvRows = [
          "Date,Digital Sales (XOF),Cash Sales (XOF),Platform Fees (XOF),Tickets Issued,Passengers Boarded,Status",
          ...reconciliations.map((r) =>
            [
              r.closing_date.toISOString().split("T")[0],
              r.total_digital_sales,
              r.total_cash_sales,
              r.total_platform_fees,
              r.total_tickets_issued,
              r.total_boarded,
              r.status,
            ].join(",")
          ),
        ].join("\n");

        reply.header("Content-Type", "text/csv");
        reply.header(
          "Content-Disposition",
          `attachment; filename="report-${query.data.start_date}-${query.data.end_date}.csv"`
        );
        return reply.status(200).send(csvRows);
      }

      return reply.status(200).send({
        period: { start: query.data.start_date, end: query.data.end_date },
        data: reconciliations,
        totals: {
          digital_sales: reconciliations.reduce(
            (s, r) => s + Number(r.total_digital_sales),
            0
          ),
          cash_sales: reconciliations.reduce(
            (s, r) => s + Number(r.total_cash_sales),
            0
          ),
          platform_fees: reconciliations.reduce(
            (s, r) => s + Number(r.total_platform_fees),
            0
          ),
          tickets_issued: reconciliations.reduce(
            (s, r) => s + r.total_tickets_issued,
            0
          ),
          boarded: reconciliations.reduce((s, r) => s + r.total_boarded, 0),
        },
      });
    }
  );

  // POST /company/reconciliation/close
  app.post(
    "/company/reconciliation/close",
    {
      onRequest: [app.authenticate, requirePermission("close_day")],
    },
    async (request, reply) => {
      const body = z
        .object({
          date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          notes: z.string().optional(),
        })
        .safeParse(request.body);

      if (!body.success) {
        return reply.status(400).send({
          error: "Invalid request body",
          code: "VALIDATION_ERROR",
        });
      }

      const companyId = request.user.company_id;
      if (!companyId) {
        return reply.status(403).send({ error: "No company", code: "NO_COMPANY" });
      }

      try {
        await reportingService.closeReconciliation({
          companyId,
          date: new Date(body.data.date),
          closedBy: request.user.sub,
          notes: body.data.notes,
        });

        const closed = await app.prisma.dailyReconciliation.findFirst({
          where: {
            company_id: companyId,
            closing_date: new Date(body.data.date),
          },
        });

        return reply.status(200).send(closed);
      } catch (err: unknown) {
        const error = err as { message?: string };
        if (error.message?.includes("already closed")) {
          return reply.status(409).send({
            error: "Reconciliation already closed",
            code: "ALREADY_CLOSED",
          });
        }
        throw err;
      }
    }
  );

  // GET /company/reconciliation/:date
  app.get(
    "/company/reconciliation/:date",
    {
      onRequest: [app.authenticate, requirePermission("view_company_financial")],
    },
    async (request, reply) => {
      const { date } = request.params as { date: string };
      const companyId = request.user.company_id;

      if (!companyId) {
        return reply.status(403).send({ error: "No company", code: "NO_COMPANY" });
      }

      const reconciliation = await app.prisma.dailyReconciliation.findUnique({
        where: {
          company_id_closing_date: {
            company_id: companyId,
            closing_date: new Date(date),
          },
        },
        include: {
          closed_by_user: {
            select: { first_name: true, last_name: true, email: true },
          },
        },
      });

      if (!reconciliation) {
        // Générer à la volée si pas encore créée
        const generated = await reportingService.upsertDailyReconciliation({
          companyId,
          date: new Date(date),
        });
        return reply.status(200).send(generated);
      }

      return reply.status(200).send(reconciliation);
    }
  );

  // GET /agent/sales-report
  app.get(
    "/agent/sales-report",
    {
      onRequest: [
        app.authenticate,
        requireRole("agent", "company_admin", "super_admin"),
      ],
    },
    async (request, reply) => {
      const query = z
        .object({
          date: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .default(new Date().toISOString().split("T")[0] ?? ""),
        })
        .safeParse(request.query);

      const dateStr = query.data?.date ?? new Date().toISOString().split("T")[0] ?? "";

      const report = await reportingService.getAgentSalesReport({
        agentId: request.user.sub,
        date: new Date(dateStr),
      });

      return reply.status(200).send(report);
    }
  );

  // POST /agent/cash-declaration
  app.post(
    "/agent/cash-declaration",
    {
      onRequest: [
        app.authenticate,
        requireRole("agent", "company_admin", "super_admin"),
      ],
    },
    async (request, reply) => {
      const body = z
        .object({
          date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          declared_amount: z.number().positive(),
          notes: z.string().optional(),
        })
        .safeParse(request.body);

      if (!body.success) {
        return reply.status(400).send({
          error: "Invalid request body",
          code: "VALIDATION_ERROR",
        });
      }

      // Calculer le montant attendu
      const report = await reportingService.getAgentSalesReport({
        agentId: request.user.sub,
        date: new Date(body.data.date),
      });

      const expectedAmount = report.total_amount;
      const declaredAmount = body.data.declared_amount;
      const discrepancy = expectedAmount - declaredAmount;

      // Audit log de la déclaration (signature électronique agent)
      await app.prisma.auditLog.create({
        data: {
          user_id: request.user.sub,
          action: "CASH_DECLARATION",
          resource: "agent_report",
          data: {
            date: body.data.date,
            expected_amount: expectedAmount,
            declared_amount: declaredAmount,
            discrepancy,
            notes: body.data.notes,
            sales_count: report.sales_count,
          },
        },
      });

      // Alerte si écart significatif
      if (Math.abs(discrepancy) > 1000) {
        app.log.warn(
          {
            agent_id: request.user.sub,
            discrepancy,
            expected: expectedAmount,
            declared: declaredAmount,
          },
          "Cash declaration discrepancy detected"
        );
      }

      return reply.status(200).send({
        date: body.data.date,
        expected_amount: expectedAmount,
        declared_amount: declaredAmount,
        discrepancy,
        signed_at: new Date().toISOString(),
        agent_id: request.user.sub,
      });
    }
  );

  // GET /company/agents
  app.get(
    "/company/agents",
    {
      onRequest: [app.authenticate, requirePermission("manage_agents")],
    },
    async (request, reply) => {
      const companyId = request.user.company_id;
      if (!companyId) {
        return reply.status(403).send({ error: "No company", code: "NO_COMPANY" });
      }

      const agents = await app.prisma.user.findMany({
        where: {
          company_id: companyId,
          role: "agent",
          is_active: true,
        },
        select: {
          id: true,
          first_name: true,
          last_name: true,
          email: true,
          last_login_at: true,
          created_at: true,
        },
      });

      // Statistiques de vente du mois courant pour chaque agent
      const startOfMonth = new Date();
      startOfMonth.setDate(1);
      startOfMonth.setHours(0, 0, 0, 0);

      const agentsWithStats = await Promise.all(
        agents.map(async (agent) => {
          const stats = await app.prisma.transaction.aggregate({
            where: {
              agent_id: agent.id,
              payment_mode: "cash",
              payment_status: "paid",
              created_at: { gte: startOfMonth },
            },
            _count: { id: true },
            _sum: { amount: true },
          });

          return {
            ...agent,
            monthly_sales: {
              count: stats._count.id ?? 0,
              total: Number(stats._sum.amount ?? 0),
            },
          };
        })
      );

      return reply.status(200).send(agentsWithStats);
    }
  );
}
