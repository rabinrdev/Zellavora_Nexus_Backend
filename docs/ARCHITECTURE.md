# Architecture

Zellavora Nexus is a multi-tenant business-management API: **Node 22 / TypeScript (strict) / Express 5 / PostgreSQL / Knex / Zod**, with Postgres-backed jobs (pg-boss), no Redis.

## Layering

```
HTTP  ->  route framework (src/platform/http)  ->  handler (module routes.ts)  ->  Knex transaction  ->  PostgreSQL (RLS)
              rate limit → authenticate → permission → flag → validate (Zod)
              → idempotency → plan/entitlement → scoped transaction → audit → respond
```

* `src/platform/` — cross-cutting services: route framework, auth tokens/passwords/TOTP, authz resolution, audit, events/outbox, jobs, files, storage drivers, mail, money, rate limits, SSRF guard, flags, entitlements, OpenAPI.
* `src/modules/<name>/routes.ts` — one file per module. Every endpoint is declared with `defineRoute({ access, scope, body/query/params (Zod), response, audit, idempotent, rateLimit, moduleFlag, entitlement })`. Declaring a route registers it in a **central registry** that drives mounting, the permission catalog, OpenAPI generation and the automated tenant-isolation test.
* `src/platform/crud.ts` — a generic tenant-scoped CRUD factory (list/get/create/update/delete/restore, optimistic concurrency, soft delete, whitelisted sort/filter).
* `migrations/` — Knex migrations (every file has `up` and `down`); `scripts/` — operational tooling.

## Request lifecycle (what the framework guarantees)

1. **Rate limit** per IP, then per user and organization once authenticated (stricter buckets on auth/MFA/invitation/API-key/search routes).
2. **Authenticate** (`src/platform/http/authn.ts`): verify the JWT, then re-check server state on every request — session not revoked/expired (idle + absolute), user active, `permission_version` current, organization active, membership active. Effective permissions are resolved server-side; the token carries no roles.
3. **Authorize**: `access` is `public | authenticated | platformAdmin | { permission }`. A route without access metadata cannot be registered (and `openapi:check` fails the build).
4. **Module flag** → `404` when the module is off for the tenant.
5. **Validate** with Zod; unknown keys are stripped, so a client-supplied `organization_id` is never read.
6. **Idempotency** (`Idempotency-Key`) for routes flagged `idempotent` (mandatory for finance/billing/provisioning).
7. **Plan gating** (billing module only): entitlements, limits, restricted accounts → `402 PLAN_LIMIT_EXCEEDED`.
8. **Run in a scoped transaction** (`tenant` | `user` | `platform`) — this sets the PostgreSQL session variables RLS depends on. Audit events are written in the *same* transaction as the change.
9. **Respond** with `{ data, meta }` or the standard error body.

## Asynchronous work

* **Domain events** are written to an `outbox_events` row in the business transaction and dispatched by a poller; subscribers: notifications, webhooks (`*`), exports, imports, scan, document reminders.
* **Queues** (`mail, notifications, webhooks, reports, imports, exports, retention, reminders, scan, provisioning, billing`) run on pg-boss with exponential backoff, a dead-letter queue per queue and a `job_runs` record (summaries only). Multiple handlers can share a queue; each recurring job is idempotent.
* In tests an in-process queue (`JOBS_DRIVER=inline`) runs the same handlers synchronously.

## Provider interfaces (no vendor lock-in)

| Concern | Interface | Drivers |
|---|---|---|
| Mail | `MailProvider` | SMTP (nodemailer), in-memory/console |
| Object storage | `StorageProvider` | local disk, S3-compatible (AWS SDK v3), in-memory |
| Malware scan | `ScanProvider` | ClamAV `clamd` (INSTREAM), stub (EICAR) |
| Payments | `PaymentProvider` | `manual`, `mock` (no gateway code) |
| Error tracking | `ErrorTracker` | Sentry-compatible HTTP, in-memory, no-op |
| Encryption keys | `KeyProvider` | environment (versioned, AES-256-GCM) |

## Data model highlights

137 tables. Money is `NUMERIC(19,4)` + ISO currency; rates `NUMERIC(9,6)`; IDs are UUIDv7; all timestamps are `timestamptz` (UTC); calendar dates are returned as `YYYY-MM-DD` strings. See [ERD.md](ERD.md) (generated) and [DATA_RETENTION.md](DATA_RETENTION.md).

## Module map

Core (always on): auth, IAM, organizations, dashboard/reports, settings, audit, files, data lifecycle, security/privacy, platform reliability, API standards.
Behind flags (default OFF in production): teams, projects, timesheets, approvals, invoices, notifications, crm, documents, cms, pagebuilder, themes, billing, integrations, reports (advanced), platform_ops, workflow, support.
