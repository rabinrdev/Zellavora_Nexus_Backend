# Runbook: rollback

Prefer **rolling the application back, not the schema**: migrations are written expand/contract so release N−1 runs on schema N.

## A. Application rollback (default)
1. Redeploy the previous image tag (same config). Verify `/api/v1/health/ready` and `/api/v1/meta/version`.
2. Record: `POST /api/v1/platform/deployments` `{status:"rolled_back"}`.
3. Disable any newly enabled module flags (`PUT /api/v1/feature-flags/:key` with `defaultEnabled:false` and per-tenant overrides).
4. Open a post-incident review.

## B. Schema rollback (only if the migration itself is harmful)
1. Put the platform in maintenance: `PATCH /api/v1/settings/application {"maintenance_mode": true}` (clients get `503 MAINTENANCE` + `Retry-After`; health stays up).
2. Stop application instances (so no writes hit a half-rolled-back schema).
3. Take a backup first: `scripts/backup.sh`.
4. Roll back **one batch**: `node node_modules/knex/bin/cli.js migrate:rollback --knexfile dist/knexfile.js` — every migration has a tested `down` (`npm run db:check`). Data created only by the rolled-back columns/tables is lost; export it first if needed.
5. Deploy the previous image, verify, clear maintenance mode.

## C. Data-level mistakes
Soft-deleted records: `POST /…/:id/restore`. Hard-deleted or corrupted data: restore into a scratch database per [RUNBOOK_RESTORE.md](RUNBOOK_RESTORE.md) and copy the affected rows back — never restore over production.

## Never
* `migrate:rollback --all` in production.
* Editing applied migrations; add a new one.
* Disabling RLS to “fix” a data issue.
