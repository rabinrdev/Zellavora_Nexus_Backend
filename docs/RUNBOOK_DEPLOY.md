# Runbook: deploy

**Preconditions:** CI green on the release commit (`lint`, `typecheck`, `db:check`, `rls:audit`, `openapi:check`, tests, `npm audit`, Docker build); `docs/RELEASE_CHECKLIST.md` complete; a fresh backup exists (`scripts/backup.sh`).

1. **Build & tag** – CI builds the image tagged with the git SHA. Set `APP_VERSION`, `GIT_SHA`.
2. **Readiness gate (staging, then production)**
   ```bash
   NODE_ENV=production npm run readiness     # exits non-zero on any blocking finding
   ```
3. **Migrate** as the owner role *before* starting new pods (migrations are backward compatible with the previous release — expand/contract):
   ```bash
   MIGRATOR_DATABASE_URL=postgres://… node node_modules/knex/bin/cli.js migrate:latest --knexfile dist/knexfile.js
   ```
   The runtime role `nexus_app` is created by the first migration; set its password with `NEXUS_APP_DB_PASSWORD` and use it in `DATABASE_URL`.
4. **Roll out** – start new instances (`node dist/src/server.js`), wait for `GET /api/v1/health/ready` = 200, shift traffic, then drain old instances (SIGTERM → graceful shutdown stops accepting, finishes in-flight, closes pools).
5. **Record** – `POST /api/v1/platform/deployments` `{version, environment, status:"succeeded"}` and `POST /api/v1/platform/releases`.
6. **Smoke test** – `/api/v1/meta/version` shows the new SHA; log in; create+read a record; check `/metrics` error rate and queue depth for 15 minutes.
7. **Module flags** – new modules ship OFF in production; enable per tenant with `PUT /api/v1/feature-flags/:key` (override) after verification.

**Configuration notes:** `NODE_ENV=production` forbids `MAIL_DRIVER=console`, requires `CORS_ORIGINS`, `SCAN_DRIVER=clamd`; module flags default OFF; Swagger off; `/metrics` needs `METRICS_TOKEN`.

**Abort criteria:** readiness fails, migration errors, ready check not green within 5 minutes, error rate > 2× baseline → follow [RUNBOOK_ROLLBACK.md](RUNBOOK_ROLLBACK.md).
