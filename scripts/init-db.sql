-- BuskinaTicket — PostgreSQL Initialization
-- Extensions requises par le schéma Prisma

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Row Level Security (RLS) est activé via les migrations Prisma
-- Les politiques d'isolation multi-compagnies sont définies dans les migrations

-- Configuration du paramètre d'application pour le RLS
-- Le contexte de compagnie est défini par l'application avant chaque requête
-- SET app.current_company_id = '<uuid>';
-- SET app.role = 'superadmin' | 'company';

-- Index de performance supplémentaires (en dehors du schéma Prisma)
-- Ces index seront créés via une migration séparée si besoin
