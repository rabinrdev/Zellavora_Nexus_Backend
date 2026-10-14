# Runbook: incident response

## 1. Detect and declare
Signals: alerts from `/metrics` (latency, 5xx rate, queue depth, DB pool), `GET /platform/health`, `operational_alerts`, `/health/ready` failing, customer reports (quote the `requestId` from the error body).

Declare: `POST /api/v1/platform/incidents {title, severity: sev1..sev4}`; assign an incident lead and a scribe.

| Severity | Definition | Response |
|---|---|---|
| sev1 | outage, data exposure, cross-tenant leak | page on-call immediately, status page, exec notified |
| sev2 | major feature down for many tenants | page on-call, 30-min updates |
| sev3 | degraded / single tenant | business hours |
| sev4 | cosmetic | backlog |

## 2. Triage with the tools we have
* **Trace a request**: `GET /api/v1/platform/diagnostics/:requestId` (audit + security events by correlation id); grep logs by `requestId`.
* **Tenant view**: `GET /platform/tenants/:id/health`, `…/config-check`.
* **Jobs**: `GET /platform/jobs?queue=…`; failed webhook deliveries `GET /webhook-deliveries?filter[status]=dead`.
* **Security events**: `GET /security-events` (lockouts, `refresh_reuse_detected`, `permission_denied`, `support_access`).
* **Support access**: ask the tenant admin to grant `POST /organization/support-access`; use a read-only support session. Do not request credentials.

## 3. Contain
* Suspected credential theft: revoke sessions (`POST /auth/logout-all` for the user, or deactivate the member), rotate API keys (`POST /api-keys/:id/rotate`), rotate `JWT_SECRET` (invalidates all access tokens) and `DATA_ENCRYPTION_KEY` (add a new version, then `POST /platform/security/rotate-encryption-key`).
* Abusive tenant: `POST /organization/suspend` (reason required) — data is preserved.
* Platform degradation: enable maintenance mode; disable a faulty module flag globally.
* **Suspected cross-tenant exposure**: sev1; stop writes if needed; run `npm run rls:audit` and the isolation suite against the affected release; preserve logs.

## 4. Communicate
Internal channel every 30 min (sev1/2). Customer notice states impact, start time, mitigation, next update. For personal-data exposure, follow legal notification timelines; privacy requests are tracked in `privacy_requests`.

## 5. Resolve and learn
Resolve: `POST /platform/incidents/:id/resolve`. Within 5 business days publish a blameless review: timeline, root cause, detection gap, corrective actions with owners. Add a regression test for every defect.
