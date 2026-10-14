# Changelog

All notable changes. Format follows Keep a Changelog; versions follow SemVer. Generate release notes from conventional commits at release time.

## [0.1.0] — Unreleased

### Added
- Multi-tenant platform foundation: PostgreSQL row-level security (FORCE, fail-closed), tenant/user/platform scopes, route registry with deny-by-default permissions, standard error contract, cursor pagination, idempotency, optimistic concurrency.
- Identity & access: argon2id, rotating refresh tokens with reuse detection, TOTP MFA + recovery codes, progressive lockout, sessions, invitations, RBAC with groups, access requests/reviews, privileged-change approvals, immediate revocation.
- Organizations, departments, locations, ownership transfer, suspension lifecycle, data export, deletion with grace period.
- Audit & security events (same-transaction, append-only), retention with legal hold, privacy requests (export/erasure).
- Settings, feature/module flags, lookups, maintenance mode, global search.
- Files: validation, quotas, malware-scan fail-closed, signed downloads; storage drivers local/S3.
- Operational modules (flagged): teams, projects/tasks, timesheets, approvals, invoices/payments/credit notes, notifications, workflow engine.
- Commercial modules (flagged): CRM + client portal, documents, CMS/page builder/themes, subscription billing with dunning, webhooks/integrations, advanced reporting, platform operations, help.
- Tooling: RLS audit, migration round-trip check, OpenAPI generation + contract tests, ERD/traceability generators, backup/restore, readiness gate, Docker, compose, CI.
- Documentation set under `docs/` including runbooks and release checklist.

### Changed
- Rate limiting can use a shared PostgreSQL store (RATE_LIMIT_STORE=postgres, default in production).
- `uuid` pinned through `overrides` (npm audit: 0 vulnerabilities); `docs/openapi.json` is generated in CI instead of committed.
