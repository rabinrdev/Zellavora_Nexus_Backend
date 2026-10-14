# Zellavora Nexus API

Multi-tenant business-management backend: identity & security, organizations, operations (projects, timesheets, approvals, invoices …) and platform control. Node 22 · TypeScript · Express 5 · PostgreSQL (row-level security) · Knex · Zod · pg-boss.

## Quick start (no Docker)
```bash
npm ci
# create .env from docs/CONFIGURATION.md (JWT_SECRET, DATA_ENCRYPTION_KEY, database URLs)
npm run dev:db                  # embedded PostgreSQL on :54329 (or use docker compose up postgres)
npm run db:migrate              # as the owner role; creates the nexus_app runtime role
npm run dev                     # http://localhost:3000  ·  Swagger UI: /api/docs
```
With Docker: `docker compose up -d postgres mailpit` (add `--profile app` to run the API image).

## Quality gate
```bash
npm run verify    # lint · typecheck · migrations up/down/up · RLS audit · OpenAPI check · tests
npm run test:coverage
```

## Where to look
| | |
|---|---|
| Architecture, tenancy, security | `docs/ARCHITECTURE.md`, `docs/TENANCY.md`, `docs/SECURITY.md` |
| API contract | `docs/API_CONVENTIONS.md`, `docs/openapi.json` |
| Feature coverage | `docs/TRACEABILITY.md` |
| Operations | `docs/RUNBOOK_*.md`, `docs/RELEASE_CHECKLIST.md`, `docs/DATA_RETENTION.md` |
| Decisions & status | `docs/DECISIONS.md`, `docs/PROGRESS.md` |

## Useful commands
`npm run admin:create` (platform admin) · `npm run readiness` · `npm run rls:audit` · `npm run openapi:gen` · `npm run docs:erd` · `npm run docs:trace`


