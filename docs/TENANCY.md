# Multi-tenancy

## The boundary

* **Global tables** (no tenant column): `users`, `sessions`, `used_refresh_tokens`, `verification_tokens`, `password_history`, `mfa_factors`, `mfa_recovery_codes`, `permissions`, `role_permissions`, `plans`, `plan_entitlements`, `feature_flags`, `feature_flag_overrides` (platform-managed; column `target_org_id`), `application_settings`, `user_preferences`, `api_version_policy`, `billing_events` (provider inbox, `target_org_id`), `release_records`, `incident_records`, `deployment_records`, `backup_runs`, `organizations`, `knex_*`.
* **Tenant-owned tables** (115): carry `organization_id uuid NOT NULL REFERENCES organizations(id)`, composite indexes beginning with `organization_id`, and **row-level security**. A few may hold platform rows with `organization_id IS NULL` (system roles, global help articles, system alerts); tenants can read those but never write them.

`npm run rls:audit` fails CI if any table with an `organization_id` column lacks `ENABLE` + `FORCE ROW LEVEL SECURITY` and a `tenant_isolation` policy.

## How the tenant is determined

`organization_id` comes **only** from the authenticated session's active organization, after verifying an active `organization_memberships` row and an active organization. Any `organization_id` in bodies, queries or headers is ignored (Zod strips unknown keys; there is no code path that reads them). Cross-tenant access returns **404** (not 403) so existence is not disclosed; a same-tenant permission failure returns **403 FORBIDDEN**.

## Defense in depth

1. **Application layer** – every tenant query also filters `organization_id = <caller org>` (`crud.ts`, services).
2. **Database layer** – each request runs in a transaction that executes
   `SELECT set_config('app.current_org', <org>, true)` (transaction-local). Policies:
   * `tenant_isolation`: `USING (organization_id = current_setting('app.current_org')::uuid)` with the same `WITH CHECK`.
   * `own_memberships` (SELECT on memberships): rows of `app.current_user`, used for “my organizations”.
   * `platform_scope`: allowed only when `app.platform = 'on'`.
3. **Roles** – migrations run as the owner; the API connects as `nexus_app` (`NOSUPERUSER NOBYPASSRLS`, no DDL). Superusers bypass RLS even with `FORCE`, which is why tests connect as `nexus_app`.
4. **Fail closed** – with no tenant context, tenant tables return **zero rows**.

## Scopes (`src/platform/scope.ts`)

| Helper | Use |
|---|---|
| `withTenant(db, {organizationId, userId}, fn)` | all tenant request work, jobs acting for one tenant |
| `withUser(db, userId, fn)` | user-level endpoints (profile, sessions, my organizations) |
| `withPlatformScope(db, reason, fn)` | platform admin routes, pre-auth flows (login, registration), housekeeping jobs — explicit and logged |

Platform admins never bypass audit; support access is a separate, tenant-granted, read-only session (see [SECURITY.md](SECURITY.md)).

## Tenant lifecycle

`pending → active ⇄ suspended → closed` (invalid transitions → 409). A suspended/closed tenant gets `403 TENANT_SUSPENDED` on every request except health, reactivation and data-export paths flagged `allowSuspendedTenant`. Sessions are rejected immediately, no cache. Deletion requests have a 14-day grace period, then `purge_organization()` removes all tenant rows (privileged, audited).

## Verification

* `tests/tenant-isolation.test.ts` – RLS behaviour at the SQL level (fail-closed, cross-tenant write rejected, append-only).
* `tests/security/route-registry.test.ts` – iterates **every registered route**: 401 unauthenticated, 403 without permission, never 5xx for foreign ids; plus real cross-tenant resource checks and forged `organization_id`.
