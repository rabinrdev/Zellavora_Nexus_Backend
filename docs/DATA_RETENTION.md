# Data retention and deletion

## Mechanisms

| Mechanism | What it does |
|---|---|
| Soft delete (`deleted_at/by`) | hides records, `restore` brings them back; partial unique indexes ignore deleted rows |
| Retention policy (`/retention/policies/:resource`) | days + `archive|purge` + `legal_hold`; applied by the `retention` job and `POST /retention/run` (dry-run by default) |
| Admin purge (`POST /retention/purge`) | permanently removes **one soft-deleted** record; blocked by legal hold and until the retention window (default 30 days) has elapsed; audited |
| Audit retention (`/audit/retention-policy`) | per-org days (30–3650) + legal hold; purge via privileged `purge_audit_events()` which records its own audit row |
| Organization deletion | `POST /organization/deletion-request` (confirm with org code) → suspended, 14-day grace, cancellable → `purge_organization()` |
| Privacy requests | access/export builds a JSON package in private storage; erasure removes the membership and anonymizes the identity when it is the user's last tenant (audit rows keep the opaque id) |

Legal hold always wins over any purge path.

## Per-table behaviour

| Data | Retention behaviour |
|---|---|
| `audit_events`, `security_events` | append-only; purged only by retention policy via privileged function; default keep 365 days (configurable) |
| `access_history`, `membership_history`, `team_membership_history`, `task_activity`, `client_activities`, `workflow_actions`, `timesheet_corrections`, `invoice_status_history`, `content_versions` | append-only; removed only with the owning organization |
| `departments`, `locations`, `teams`, `projects`, `tasks`, `billing_customers`, `leads`, `contacts`, `documents`, `content_items`, `files` | soft delete → purge after window |
| `invoices`, `payments`, `credit_notes`, `payment_allocations` | financial records: never soft-purged individually; follow tenant deletion / statutory retention set by the operator |
| `files` objects | removed from storage on delete; quota decremented immediately |
| `export_jobs` + export files | link expires after 24 h; rows follow `export_jobs` retention |
| `idempotency_records` | 24 h TTL, purged hourly |
| `verification_tokens` | purged 7 days after expiry |
| `used_refresh_tokens` | purged when the owning session's absolute expiry passes |
| `job_runs` | operational metadata; the hourly housekeeping job deletes rows older than 90 days |
| `api_request_audit` | metadata only; retained (the app role has no DELETE) — prune with an operator job/partitioning |
| `webhook_events`, `webhook_deliveries` | kept to support replay/retry; removed with the organization (operators may prune by age) |

## Backups

`scripts/backup.sh` (`pg_dump -Fc`, SHA-256, retention pruning), `scripts/restore-test.sh` (restore into a scratch database + sanity queries). **RPO** = backup interval (24 h by default; add WAL archiving for < 15 min). **RTO** target < 1 h. A stale-backup alert opens automatically after 36 h. Restores of tenant-deleted data are not possible after the grace period — deletion is irreversible by design.
