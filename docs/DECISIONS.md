# Decision log

Format: context · options · choice · consequence.

## D-001 Embedded PostgreSQL for local development and tests
The build machine had no Docker/psql. Options: install Docker; Testcontainers; `embedded-postgres`. **Chose** `embedded-postgres` (`npm run dev:db`, port 54329). Consequence: day-to-day dev/test ran on PostgreSQL 18.4; the whole gate (migrations up/down/up, RLS audit, all tests) was **also executed on PostgreSQL 16.14** and passes. CI and docker-compose pin 16.

## D-002 Native install scripts
`argon2`, `esbuild`, `@embedded-postgres/*` approved (required by the chosen stack); `@scarf/scarf` (telemetry) denied.

## D-003 Runtime role vs. owner role
Migrations run as owner; the API runs as `nexus_app` (`NOSUPERUSER NOBYPASSRLS`). Superusers bypass RLS even with `FORCE`, so all isolation tests connect as `nexus_app`.

## D-004 RLS fails closed and uses transaction-local settings
Policies compare `organization_id` with `nullif(current_setting('app.current_org', true), '')::uuid`. No context ⇒ zero rows. `SET LOCAL` semantics via `set_config(..., true)` so pooled connections never leak a tenant.

## D-005 Cross-tenant access returns 404
Avoids existence disclosure. Same-tenant missing permission is 403 with the standard body.

## D-006 Failure bookkeeping must survive the failing request
Lockout counters and security events are committed **before** the error is raised (`errorAfterCommit` / result-union pattern); throwing inside the transaction would roll them back.

## D-007 Permission catalog derived from route metadata
Permissions are the union of route `access.permission` values plus a short `EXTRA_PERMISSIONS` list; system-role sets are computed by rule and re-synced at boot. Consequence: adding a route automatically extends the catalog and the Organization Admin role.

## D-008 `permission_version` for immediate revocation
Tokens carry `pv`; any role/group/membership/password change bumps the user's version, invalidating outstanding tokens on the next request (no allow-list cache required). Team membership only bumps when team-scoped roles exist.

## D-009 Refresh tokens in the response body (no cookie)
CSRF double-submit is therefore not needed. Cookie transport can be added later with `HttpOnly; Secure; SameSite=Strict` + CSRF token.

## D-010 Rate limiting: shared Postgres store in production
Buckets use `rate-limiter-flexible`. `RATE_LIMIT_STORE=postgres` (default in production) keeps counters in the `rate_limits` table so all instances share them; an in-memory insurance limiter takes over if the store is unreachable (the API stays up). `memory` (default elsewhere) is per instance. Verified with two limiter instances over one pool (`tests/infra.e2e.test.ts`).

## D-011 Outbox + poller instead of LISTEN/NOTIFY
Events are inserted transactionally and dispatched by a 2 s poller (and on demand in tests). Simpler failure semantics; ordering preserved per batch.

## D-012 Unmetered by default for billing
Organizations with no plan/subscription are *unmetered* (`organizations.plan_key IS NULL`); entitlement enforcement starts only when a plan is assigned or a subscription exists **and** `module.billing` is on. Prevents surprising limits on self-hosted/MVP installs.

## D-013 Subscription charges are platform documents
`subscription_invoices` is its own table rather than M12 `invoices` (which belong to the tenant as seller). Linking is possible if the platform operator also runs as a tenant.

## D-014 Money
`decimal.js` with explicit currency exponent (0/2/3 decimals), per-org rounding mode, per-line computation, totals always recomputed server-side; the database additionally forbids edits to totals of `paid`/`void` invoices.

## D-015 Gap-free invoice numbers
Numbers are allocated at `send` (not at draft) from a row-locked counter in the same transaction; drafts have no number, voided invoices keep theirs.

## D-016 Approvals rounds
Resubmission increments `round` instead of deleting decisions, so history stays complete and `(step, approver, round)` stays unique.

## D-017 Feature flags target column rename
`feature_flag_overrides.target_org_id` (not `organization_id`): the table is platform-managed configuration, not tenant-owned data; keeps the RLS audit strict and meaningful.

## D-018 Webhook retries happen after commit
A delivery attempt records its result inside a transaction; the next attempt is enqueued only after commit (prevents self-deadlock with synchronous queues and double-sends with real ones).

## D-019 Support access via a distinct session realm
Platform support never uses a tenant membership: `sessions.realm='support'`, read-only permission set (`*:read`), bound to an unexpired tenant grant checked on every request.

## D-020 Public CMS serves snapshots
Public endpoints read the `content_versions` snapshot at `published_version`; editing a published item never changes live content until publish is executed again.

## D-021 Spec truncation
The received specification ended inside Module 28. Features F-248–F-250 and F-258–F-260 and Modules 30–31 are marked `unmapped` in `TRACEABILITY.md` rather than guessed; Module 29 (API standards F-244–F-247) is implemented from §5.1.

## D-022 Global search is an addition
`GET /search` (pg_trgm) was added from the technology table; each source declares its permission and module flag so search never widens access.


## D-023 One declaration drives runtime and docs (extend `defineRoute`, do not add a second wrapper)
`defineRoute()` already mounted every route (validation, auth, tenancy, idempotency, rate limit). It now also carries `operationId` (looked up in `src/platform/openapi/operations.ts`), and the OpenAPI document is built from the same registry, so docs cannot disagree with behavior. A route without a catalog entry fails `npm run openapi:check` and the naming test.

## D-024 Contract documentation lives in `src/modules/<module>/docs.ts`, attached by operationId
Handlers stay untouched. `documentRoutes({ operationId: { response, description, … } })` adds response schemas, descriptions, list sort/filter whitelists and examples; an unknown operationId throws at boot, so a rename cannot orphan docs. CRUD resources get item schemas, summaries and sort/filter lists generated from `crudResource` config (the code's own whitelist).

## D-025 No separate "controller"/"service" functions to rename
Handlers are inline in `defineRoute` (there are no controller classes). The `operationId` is the single name; it is also the SDK method name. Naming test: operationId uniqueness, camelCase, vocabulary verb, plural-kebab paths, no `{id}`, Express param names == OpenAPI names.

## D-026 Path parameter `:id` is renamed in the route path, not in handlers
`defineRoute` rewrites `:id` to `:projectId`, `:taskId`, … from the resource that precedes it (`describeParamNames`) and maps it back to `params.id` before validation, so handler code and Zod schemas are unchanged. Request/response bodies and status codes are unchanged. One real path move: `GET /help/articles/:slug` → `GET /help/articles/by-slug/{slug}` (it was the same URL shape as `PATCH /help/articles/{articleId}`, which OpenAPI cannot express).

## D-027 Response schemas for row pass-through endpoints come from the database
`scripts/gen-db-schemas.ts` snapshots column names/types/nullability of the migrated schema into `db-rows.generated.ts`; `rowOf(table)` builds the Zod schema as `rowToApi()` returns it (camelCase, ISO timestamps, numerics as decimal strings). Re-run `npm run docs:db-schemas` after a migration.

## D-028 Docs are verified against real traffic
`tests/helpers/doc-check.ts` records every response any e2e test causes and fails when the status is not declared for that operation; `tests/contract.e2e.test.ts` validates real bodies against the generated JSON Schema (Ajv 2020). Statuses that no test exercises (for example a rarely hit 409) are derived from handler source and explicit `errors` lists, so they are best-effort.

## D-029 Serving
`/api/docs` (Swagger UI), `/api/redoc`, `/api/docs/openapi.{json,yaml}`; `?audience=full` includes internal operations (default `frontend`). Enabled by `SWAGGER` (default on, including production); optional HTTP Basic gate `DOCS_BASIC_AUTH_USER/PASS`; "Try it out" disabled in production; the first server is `/` (same origin) because the docs CSP (`connect-src 'self'`) blocks cross-origin calls. Redoc is pinned to 2.5 (3.x needs an ES module build) and served from a versioned URL.

## D-030 SDK is its own package
`sdk/` (`@zellavora/nexus-api-client`) has its own dependencies because `openapi-typescript` requires TypeScript 5 while the API uses 6. Types and the operation map are generated and committed; CI regenerates and fails on a diff.

## D-031 Not done / limits
oasdiff breaking-change detection was not wired (no binary in the build environment). Postman and spec examples use fake demo data only. Request statuses never exercised by tests are best-effort (D-028).
