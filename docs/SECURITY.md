# Security

## Prime directive

Tenant isolation and authorization are enforced **server-side**. The server never trusts client-supplied organization IDs, role claims or file URLs, and never stores plaintext passwords, API secrets or access tokens.

## Authentication

* Passwords: **argon2id**; policy (length 12, ≥3 character classes, history of 5, no email-name, common-password list) applied from the security policy; unknown accounts burn equivalent CPU (dummy hash) and return the same message.
* Access tokens: HS256 JWT, **15 minutes**, claims `sub, sid, org, pv, exp` only. Every request re-validates session, user, tenant, membership and `permission_version`; role changes, deactivation, logout, password reset and suspension take effect **immediately**.
* Refresh tokens: opaque, hashed, **rotating**; replaying a rotated token revokes the whole family (`refresh_reuse_detected`). Delivered in the JSON body (no cookie), so CSRF double-submit does not apply; if a cookie transport is added it must be `HttpOnly; Secure; SameSite=Strict`, path-scoped, with a CSRF token.
* Lockout: progressive (threshold 5, base 1 min, doubling to 60 min), recorded as security events; reset by time, password reset or admin.
* MFA: TOTP with encrypted secrets, hashed single-use recovery codes (shown once), org policy `requiredForAll | requiredForRoles` (session is `pending_mfa` and limited to MFA endpoints until enrolled).
* Sessions: idle and absolute expiry from the policy; list/revoke own sessions; logout-all.
* Machine access: API keys (`nxk_…`, SHA-256 + prefix stored, shown once, scoped ⊆ creator's permissions, expiry, rotation with overlap window), request metadata in `api_request_audit`.
* Client portal: separate JWT audience/secret and account table; portal tokens cannot reach staff routes and vice-versa.

## Authorization

* RBAC, **deny-by-default**: a route without `access` metadata cannot be registered.
* Resolution: `org-scoped role assignments ∪ roles granted through groups`; scoped (team/project) assignments are resolved per resource. No explicit deny.
* No privilege escalation: you can only grant permissions you hold; system roles are immutable; the last Organization Admin cannot be removed/demoted; privileged changes need a **different** admin's approval when enabled.
* Project RBAC is enforced on top of org RBAC; document ACLs are enforced on top of `documents:*`.
* Consistent 403 body; cross-tenant → 404.

### System roles (189 permissions in the catalog)

| Role | Permissions | Intent |
|---|---|---|
| Super Admin | platform scope (`is_platform_admin`) | platform routes only; no tenant data access without a tenant-granted support session |
| Organization Admin | 189 (all tenant permissions) | full control of the organization |
| Manager | 113 | operational work, approvals, read of members/organization; no security/IAM/billing/integration admin, no `manage_all` |
| Member | 93 | read/create/update/upload/comment on operational resources; can request access |
| Viewer | 36 | read-only on non-administrative resources; can request access |

The authoritative matrix is `GET /api/v1/iam/permission-matrix`; the catalog is synced from route metadata at boot (`syncCatalogAndSystemRoles`).

## Data protection

* Secrets (MFA secrets, webhook secrets, integration configs) are encrypted with **AES-256-GCM**, versioned keys (`DATA_ENCRYPTION_KEY="2:<new>,1:<old>"`), via a `KeyProvider`. `POST /platform/security/rotate-encryption-key` re-encrypts stored secrets.
* Tokens (verification, reset, invitation, refresh, API keys) are stored as SHA-256 hashes, single-use, expiring.
* Logs: `pino` redaction of auth headers/cookies/passwords/tokens/secrets; `deepScrub` applied to audit metadata, error tracking and diagnostics; request logs are metadata only. Unit-tested.
* Files: private storage under random keys, size/extension/magic-byte/declared-type validation, org quota, **malware scan fail-closed** (only `clean` is downloadable), signed ≤5-minute links, `nosniff` + attachment disposition.
* Rich text is sanitized server-side with an allow-list; CSV exports neutralize spreadsheet formulas.

## Platform hardening

* `helmet`, CORS allow-list, `hpp`, 1 MB JSON limit, `x-powered-by` off, request timeout, graceful shutdown.
* **SSRF guard** on every outbound request (webhooks): https only in production, no credentials in URL, DNS resolved then every address checked against private/loopback/link-local/CGNAT/metadata ranges (IPv4, IPv6, mapped), no redirects, 10 s timeout.
* Rate limits (`RATE_LIMITED` + `Retry-After`), idempotency, optimistic concurrency (`If-Match` / `rowVersion` → 412).
* Append-only tables (`audit_events`, `security_events`, `access_history`, `membership_history`, `invoice_status_history`, `timesheet_corrections`, `task_activity`, `workflow_actions`, `team_membership_history`, `client_activities`, `content_versions`, `billing_events` payload) are enforced by triggers; deletion only through audited privileged functions (`purge_audit_events`, `purge_organization`).
* Finalized invoices (`paid`, `void`) and published workflow versions are immutable at the database level.

## Support access

A tenant admin grants a time-boxed (≤72 h), reasoned, revocable grant. A platform admin may then open a **read-only** session (`realm=support`). Every request is recorded in the tenant's security log; opening the session is audited in both the tenant and platform logs; revoking the grant kills live support sessions immediately.

## Reporting a vulnerability

Do not file public issues. Email the security contact configured for your deployment; include affected endpoint, reproduction and impact. We acknowledge within 2 business days.

## Known limitations / operational responsibilities

* Rate limiting uses a shared PostgreSQL store in production (`RATE_LIMIT_STORE=postgres`); behind a CDN/WAF also limit at the edge. If the store is unreachable the API degrades to per-instance limiting rather than failing.
* Breached-password checking uses a local common-password list; plug a larger list for production.
* `npm audit` is clean (0 vulnerabilities; the `uuid` transitive of `exceljs` is pinned via `overrides`). `npm audit`/OSV run in CI; review findings before each release.



