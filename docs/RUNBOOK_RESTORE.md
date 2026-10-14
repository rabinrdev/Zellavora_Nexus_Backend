# Runbook: backup and restore

## Backups
```bash
DATABASE_URL=postgres://owner@host/nexus BACKUP_DIR=/var/backups/nexus ./scripts/backup.sh
```
Custom-format dump, SHA-256 sidecar, pruning after `RETENTION_DAYS` (14). Schedule at least daily; set `NEXUS_API_URL` + `NEXUS_ADMIN_TOKEN` to record each run (`POST /platform/backups`) so the staleness alert (> 36 h) works. Ship dumps off-host and encrypt at rest. Object storage (S3/local files) must be backed up/versioned separately.

## Verify (do this on a schedule — an untested backup is not a backup)
```bash
ADMIN_DATABASE_URL=postgres://postgres@host/postgres ./scripts/restore-test.sh backups/nexus-<stamp>.dump
```
Restores into a throw-away database and checks counts, migrations and RLS-enabled table counts, then drops it. Alert if it fails.

## Restore (disaster)
1. Declare an incident ([RUNBOOK_INCIDENT.md](RUNBOOK_INCIDENT.md)); enable maintenance mode.
2. Provision a new PostgreSQL ≥ 16 instance; create roles as in the first migration (`nexus_app` is `NOSUPERUSER NOBYPASSRLS`).
3. `pg_restore --no-owner --dbname=<new> backups/<file>.dump`
4. `npm run readiness` against the new database (migrations applied, RLS enforced, `nexus_app` role correct).
5. Point `DATABASE_URL`/`MIGRATOR_DATABASE_URL` at the new instance, start the API, check `/health/ready`.
6. Re-point object storage, verify a sample download, re-enable traffic, record the incident.

## Targets
**RPO** = backup interval (24 h; use WAL archiving/PITR for < 15 min). **RTO** < 1 h for the database plus DNS/config time.

## Partial recovery (a single tenant or table)
Restore to a scratch database, `COPY` the needed rows with `organization_id = <tenant>` and insert them with `withPlatformScope`-style privileged access (owner role). Never restore over live data.
