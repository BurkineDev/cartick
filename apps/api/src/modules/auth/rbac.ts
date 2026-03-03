/**
 * RBAC — Role-Based Access Control
 * Matches the permission matrix from the architecture spec
 */
import type { FastifyRequest, FastifyReply } from "fastify";
import type { UserRole } from "@buskinaticket/database";

export type Permission =
  | "manage_buses_routes"     // Créer/modifier bus & routes
  | "sell_cash"               // Vendre cash
  | "cancel_own_tickets"      // Annuler ses propres billets
  | "cancel_any_ticket"       // Annuler n'importe quel billet
  | "scan_boarding"           // Scanner embarquement
  | "view_own_financial"      // Voir son rapport de ventes
  | "view_company_financial"  // Voir rapport financier compagnie
  | "close_day"               // Clôturer journée
  | "manage_companies"        // Gérer compagnies (super_admin uniquement)
  | "book_ticket"             // Réserver en ligne
  | "manage_agents";          // Gérer agents

// Permission matrix matching specification
const ROLE_PERMISSIONS: Record<UserRole, Permission[]> = {
  super_admin: [
    "manage_buses_routes",
    "sell_cash",
    "cancel_any_ticket",
    "scan_boarding",
    "view_company_financial",
    "view_own_financial",
    "close_day",
    "manage_companies",
    "book_ticket",
    "manage_agents",
  ],
  company_admin: [
    "manage_buses_routes",
    "sell_cash",
    "cancel_any_ticket",
    "view_company_financial",
    "view_own_financial",
    "close_day",
    "book_ticket",
    "manage_agents",
  ],
  agent: [
    "sell_cash",
    "cancel_own_tickets",
    "view_own_financial",
    "book_ticket",
  ],
  scanner: [
    "scan_boarding",
  ],
  client: [
    "book_ticket",
  ],
};

export function hasPermission(role: UserRole, permission: Permission): boolean {
  const permissions = ROLE_PERMISSIONS[role];
  return permissions.includes(permission);
}

/**
 * Fastify hook factory — require a specific permission
 */
export function requirePermission(permission: Permission) {
  return async function (request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      return reply.status(401).send({
        error: "Authentication required",
        code: "UNAUTHORIZED",
      });
    }

    if (!hasPermission(request.user.role, permission)) {
      return reply.status(403).send({
        error: "Insufficient permissions",
        code: "INSUFFICIENT_ROLE",
      });
    }
  };
}

/**
 * Fastify hook factory — require one of several roles
 */
export function requireRole(...roles: UserRole[]) {
  return async function (request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      return reply.status(401).send({
        error: "Authentication required",
        code: "UNAUTHORIZED",
      });
    }

    if (!roles.includes(request.user.role)) {
      return reply.status(403).send({
        error: "Insufficient permissions",
        code: "INSUFFICIENT_ROLE",
      });
    }
  };
}
