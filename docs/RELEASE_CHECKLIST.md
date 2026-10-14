# Release checklist

Copy into the release ticket. Every box must be checked or explicitly waived with a reason.

## Code & CI
- [ ] CI green: lint, typecheck, `db:check` (up/down/up), `rls:audit`, `openapi:check`, tests with coverage ≥ 80% on `src/platform` + auth/iam/organizations/audit
- [ ] `npm audit --omit=dev --audit-level=high` and OSV scan reviewed
- [ ] Docker image built from the release SHA; image scanned
- [ ] `CHANGELOG.md` updated; `docs/openapi.json` regenerated (`npm run openapi:gen`); `docs/ERD.md`/`TRACEABILITY.md` regenerated

## Data & migrations
- [ ] Migrations are backward compatible with the previous release (expand/contract)
- [ ] Backup taken and `restore-test.sh` passed within the last 7 days
- [ ] New tenant tables have RLS + grants (the RLS audit proves it)

## Configuration (`NODE_ENV=production npm run readiness` shows READY)
- [ ] `JWT_SECRET` ≥ 48 random chars; `DATA_ENCRYPTION_KEY` is a real 32-byte key from the secret manager
- [ ] Runtime connects as `nexus_app`, not a superuser
- [ ] `CORS_ORIGINS` set; `SWAGGER` off; `METRICS_TOKEN` set
- [ ] `MAIL_DRIVER=smtp`, `SCAN_DRIVER=clamd` reachable, `STORAGE_DRIVER` points at private storage
- [ ] `ERROR_TRACKING_DSN` set; log shipping and alert rules in place
- [ ] Module flags reviewed: only intended modules enabled per tenant

## Security
- [ ] Cross-tenant isolation suite passed on this build
- [ ] No new route without permission metadata (build enforces)
- [ ] Secrets/rotation dates reviewed; API keys older than policy rotated

## Rollout
- [ ] Deployed to staging; smoke tests and the critical e2e flow passed
- [ ] Rollback plan reviewed ([RUNBOOK_ROLLBACK.md](RUNBOOK_ROLLBACK.md)); on-call informed
- [ ] Production deployed; `/api/v1/meta/version` verified; deployment/release recorded via the platform API
- [ ] 15-minute post-deploy watch: error rate, latency, queue depth, DB pool, failed jobs
