# Progress

**State:** Phases 0–4 implemented against the specification that was received (truncated at Module 28). Last green gate: `npm run verify` — see the latest commit.

## Delivered
| Area | Status |
|---|---|
| Platform (route framework, tenancy/RLS, auth, authz, audit, events/outbox, jobs, files, mail, money, rate limits, SSRF, flags, entitlements, OpenAPI) | done |
| M1 Auth · M2 IAM · M3 Organizations · M4 Dashboard/reports · M6 Settings · M7 Audit · M23 Data lifecycle · M24 Security/privacy · M25 Reliability · M27 Quality/release | done (MVP, always on) |
| M8 Teams · M9 Projects/tasks · M10 Timesheets · M11 Approvals · M12 Invoices/payments · M13 Notifications · M26 Workflow | done (flagged) |
| M14 CRM/portal · M15 Documents · M16 CMS · M17 Page builder · M18 Themes | done (flagged) |
| M19 Billing · M20 Integrations/webhooks · M21 Advanced reporting · M22 Platform ops · M28 Help | done (flagged) |
| M29 API standards (versioning, pagination, idempotency, error contract) | done |
| Global search (`/search`) | done (addition) |
| Provider interfaces + drivers: mail (SMTP/memory), storage (local/S3/memory), scan (clamd/stub), payments (manual/mock), error tracking (HTTP/memory/no-op) | done |
| Tooling: RLS audit, db round-trip, OpenAPI gen/check, ERD, traceability, backup/restore, readiness, super-admin CLI, seeds, Docker, compose, CI | done |
| Documentation: architecture, tenancy, security, API conventions, retention, runbooks, release checklist, decisions, traceability, ERD, changelog | done |

## Quality
* 100+ automated tests (unit, integration on real PostgreSQL, security/tenant-isolation across **every registered route**, end-to-end flows, OpenAPI contract).
* Coverage on `src/platform` + auth/iam/organizations/audit: > 80% lines (threshold enforced in CI).
* 138 tables; 115 tenant-owned tables all enforce RLS (`npm run rls:audit`).

## Not done / needs input
* Spec tail missing: Module 28 remainder, Modules 30–31, Appendix A rows for F-248–F-250 and F-258–F-260, §12 phase plan (marked `unmapped` in TRACEABILITY).
* Verified on a live server in the build environment: PostgreSQL 16.14 (full gate), pg-boss (queues, DLQs, schedule, handlers), shared rate limiter.
* Not executable in the build environment (no Docker/network services): Docker image build and the compose stack, S3/ClamAV/SMTP against real services (drivers are unit-tested with fakes and a fake clamd). Validate in staging with `npm run readiness`.

## Resuming
Read `PROMPT.md` (if restored) and this file, run `npm run dev:db`, `npm run db:migrate`, `npm run verify`.

