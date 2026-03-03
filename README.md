# BuskinaTicket

**Infrastructure Digitale de Billetterie Routière — Burkina Faso**

Version `2.0.0` — Architecture Production
WendTech — Solutions Digitales Africaines

---

## Architecture

Monorepo Turborepo avec pnpm workspaces.

```
buskinaticket/
├── apps/
│   └── api/              # Fastify API backend (Node.js)
├── packages/
│   └── database/         # Prisma schema + migrations
├── scripts/              # Utilitaires (génération clés, init DB)
├── docker-compose.yml    # Infrastructure locale (PostgreSQL + Redis)
└── .github/workflows/    # CI/CD GitHub Actions
```

## Stack Technique

| Composant | Technologie |
|-----------|-------------|
| Backend API | Node.js 22 + Fastify 5 |
| Base de données | PostgreSQL 16 (RLS, FOR UPDATE) |
| Cache / Sessions | Redis 7 (idempotence, blacklist) |
| Queue | BullMQ (webhooks, SMS, jobs) |
| ORM | Prisma 6 |
| Auth | JWT RS256 + ECDSA P-256 (QR) |

## Prérequis

- Node.js 22+
- pnpm 10+
- Docker + Docker Compose (pour PostgreSQL et Redis)
- OpenSSL (pour la génération des clés)

## Démarrage Rapide

```bash
# 1. Installer les dépendances
pnpm install

# 2. Démarrer PostgreSQL + Redis
docker compose up -d

# 3. Générer les clés cryptographiques
bash scripts/generate-keys.sh

# 4. Configurer l'environnement
cp apps/api/.env.example apps/api/.env
# Remplir les valeurs dans .env

# 5. Migrer la base de données
pnpm db:migrate

# 6. Seeder les données initiales
pnpm db:seed

# 7. Démarrer l'API en développement
pnpm dev
```

## Modules

### Auth
- JWT RS256 (access token 15min)
- Refresh token httpOnly cookie (7j, rotation à chaque utilisation)
- Blacklist Redis pour invalidation immédiate
- RBAC: `super_admin`, `company_admin`, `agent`, `scanner`, `client`

### Inventory (Cœur du système)
- Machine à états formelle pour les sièges
- `SELECT FOR UPDATE SKIP LOCKED` — anti-double-vente
- Optimistic locking via champ `version`
- Hold automatique expirant (job cleanup 30s)

### Payment
- Orange Money, Moov Money, Wave, Cash
- Idempotence via `X-Idempotency-Key` + Redis cache
- Webhook validation HMAC-SHA256 + IP whitelist
- États: `pending → processing → paid | failed | expired | disputed | refunded`

### Ticketing
- QR code JWT signé ECDSA P-256
- Vérification offline possible (clé publique pré-chargée)
- Distribution: SMS, WhatsApp, impression thermique ESC/POS

### Boarding
- Scan QR en ligne et offline (PWA)
- Anti-double-scan Redis (TTL 24h)
- Sync file d'attente offline → premier synchronisé gagne

### Reporting
- Réconciliation quotidienne formelle
- Détection automatique des écarts (> 2% = `disputed`)
- Clôture avec signature électronique → état `closed` immuable
- Export CSV

## Sécurité

- Row Level Security (RLS) PostgreSQL — isolation multi-compagnies
- TLS 1.3 obligatoire + HSTS
- Rate limiting par endpoint (voir spec)
- Données passagers chiffrées au repos
- Numéros de téléphone hashés SHA-256 (RGPD)
- Audit log immuable (INSERT-only)

## Tests

```bash
pnpm test
```

## API

Base URL: `https://api.buskinaticket.bf/v1`

Health check: `GET /health`

Voir [documentation complète de l'API](docs/api.md) pour la liste des endpoints.

## Contrainte Absolue

> Un siège ne peut **jamais** être vendu deux fois. Cette contrainte prime sur tout.
> En cas de conflit technique, le système refuse la vente.
