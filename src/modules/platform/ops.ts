import { z } from 'zod';
import { defineRoute } from '../../platform/http/route.js';
import { AppError } from '../../platform/errors.js';
import { newId, randomToken, sha256 } from '../../platform/crypto.js';
import { signAccessToken } from '../../platform/auth/tokens.js';
import { paginate, listQuerySchema, type ListQuery } from '../../platform/pagination.js';
import { rowToApi } from '../../platform/crud.js';
import { recordAudit, recordSecurityEvent } from '../../platform/audit.js';
import { provisionOrganization } from '../organizations/provision.js';
import { withPlatformScope } from '../../platform/scope.js';
import { jobRegistrars } from '../../platform/job-handlers.js';

const M = 'platform_ops';
const FLAG = 'module.platform_ops';
const obj = z.record(z.string(), z.unknown());
const uuid = z.string().uuid();

// ---- tenant-granted, time-boxed support access (F-236 / F-145) -----------------------------------------------------------

defineRoute({
  method: 'post', path: '/organization/support-access', module: M, moduleFlag: FLAG, summary: 'Grant time-boxed, read-only support access',
  access: { permission: 'support_access:manage' }, allowSuspendedTenant: true,
  body: z.object({ hours: z.number().int().min(1).max(72).default(4), reason: z.string().trim().min(5).max(300) }), response: obj,
  audit: { action: 'support_access.granted', resourceType: 'support_access_grant' },
  async handler(c) {
    const id = newId();
    const expiresAt = new Date(c.svc.now().getTime() + c.body.hours * 3600_000);
    await c.trx('support_access_grants').insert({ id, organization_id: c.orgId(), granted_by: c.auth!.userId, reason: c.body.reason, expires_at: expiresAt });
    return { status: 201, data: { id, expiresAt: expiresAt.toISOString(), readOnly: true } };
  },
});

defineRoute({
  method: 'get', path: '/organization/support-access', module: M, moduleFlag: FLAG, summary: 'Support access grants', access: { permission: 'support_access:manage' },
  allowSuspendedTenant: true, response: obj,
  async handler(c) {
    return { data: (await c.trx('support_access_grants').where({ organization_id: c.orgId() }).orderBy('created_at', 'desc').limit(50)).map((r) => rowToApi(r)) };
  },
});

defineRoute({
  method: 'delete', path: '/organization/support-access/:id', module: M, moduleFlag: FLAG, summary: 'Revoke a support access grant',
  access: { permission: 'support_access:manage' }, allowSuspendedTenant: true, params: z.object({ id: uuid }),
  audit: { action: 'support_access.revoked', resourceType: 'support_access_grant' },
  async handler(c) {
    const n = await c.trx('support_access_grants').where({ id: c.params.id, organization_id: c.orgId() }).whereNull('revoked_at').update({ revoked_at: c.svc.now() });
    if (!n) throw new AppError('NOT_FOUND', 'Grant not found');
    // kill live support sessions for this tenant immediately
    await withPlatformScope(c.svc.db, 'support-revoke', (t) => t('sessions').where({ realm: 'support', active_organization_id: c.orgId() }).whereNull('revoked_at').update({ revoked_at: c.svc.now(), revoked_reason: 'support_grant_revoked' }));
    return { status: 204, auditResourceId: c.params.id };
  },
});

defineRoute({
  method: 'post', path: '/platform/support/impersonate', module: M, moduleFlag: FLAG, summary: 'Open a read-only support session',
  access: 'platformAdmin', body: z.object({ organizationId: uuid }), response: obj,
  async handler(c) {
    const grant = await c.trx('support_access_grants').where({ organization_id: c.body.organizationId }).whereNull('revoked_at').where('expires_at', '>', c.svc.now()).first();
    if (!grant) throw new AppError('FORBIDDEN', 'The tenant has not granted support access');
    const user = await c.trx('users').where({ id: c.auth!.userId }).first();
    const sid = newId();
    const expires = new Date(Math.min(new Date(grant.expires_at).getTime(), c.svc.now().getTime() + 3600_000));
    await c.trx('sessions').insert({
      id: sid, user_id: user.id, active_organization_id: c.body.organizationId, refresh_token_hash: sha256(randomToken(32)), family_id: sid, realm: 'support',
      ip: c.ip, user_agent: c.userAgent?.slice(0, 300) ?? null, idle_expires_at: expires, absolute_expires_at: expires,
    });
    const token = await signAccessToken(c.svc.env.JWT_SECRET, { sub: user.id, sid, org: c.body.organizationId, pv: user.permission_version });
    // both logs: platform-level audit (no org) and the tenant's own audit trail
    await c.audit({ action: 'support.session_opened', resourceType: 'organization', resourceId: c.body.organizationId, metadata: { grantId: grant.id } });
    await recordAudit(c.trx, { organizationId: c.body.organizationId, actorId: c.auth!.userId, actorType: 'platform_support', correlationId: c.requestId, ip: c.ip },
      { action: 'support.session_opened', resourceType: 'organization', resourceId: c.body.organizationId, metadata: { grantId: grant.id } });
    await recordSecurityEvent(c.trx, { organizationId: c.body.organizationId, actorId: c.auth!.userId, correlationId: c.requestId, ip: c.ip }, 'support_session_opened');
    return { status: 201, data: { accessToken: token, expiresAt: expires.toISOString(), readOnly: true } };
  },
});

// ---- tenant health, quotas, diagnostics (F-143, F-144, F-235, F-256) ------------------------------------------------------------

export async function tenantHealth(trx: import('../../platform/scope.js').Trx, orgId: string) {
  const org = await trx('organizations').where({ id: orgId }).first();
  if (!org) throw new AppError('NOT_FOUND', 'Organization not found');
  const members = await trx('organization_memberships').where({ organization_id: orgId, status: 'active' }).count({ c: '*' }).first();
  const storage = await trx('storage_usage').where({ organization_id: orgId }).first();
  const failedJobs = await trx('job_runs').where({ organization_id: orgId }).whereIn('status', ['failed', 'dead_letter']).where('started_at', '>', new Date(Date.now() - 86400_000)).count({ c: '*' }).first();
  const lastLogin = await trx('security_events').where({ organization_id: orgId, event: 'login' }).max({ at: 'occurred_at' }).first();
  const sub = await trx('subscriptions').where({ organization_id: orgId }).orderBy('created_at', 'desc').first();
  const failedDeliveries = await trx('webhook_deliveries').where({ organization_id: orgId }).whereIn('status', ['failed', 'dead']).count({ c: '*' }).first();
  return {
    organizationId: orgId, status: org.status, plan: org.plan_key, activeMembers: Number((members as { c: string }).c),
    storageBytes: Number(storage?.bytes_used ?? 0), failedJobsLast24h: Number((failedJobs as { c: string }).c),
    lastLoginAt: (lastLogin as { at: Date | null }).at ? new Date((lastLogin as { at: Date }).at).toISOString() : null,
    subscriptionStatus: sub?.status ?? null, failedWebhookDeliveries: Number((failedDeliveries as { c: string }).c),
  };
}

defineRoute({
  method: 'get', path: '/platform/tenants/:id/health', module: M, moduleFlag: FLAG, summary: 'Tenant health snapshot', access: 'platformAdmin',
  params: z.object({ id: uuid }), response: obj,
  async handler(c) {
    const snap = await tenantHealth(c.trx, c.params.id);
    await c.trx('tenant_health_snapshots').insert({ id: newId(), organization_id: c.params.id, snapshot: JSON.stringify(snap) });
    return { data: snap };
  },
});

defineRoute({
  method: 'get', path: '/platform/tenants/:id/config-check', module: M, moduleFlag: FLAG, summary: 'Tenant configuration checker', access: 'platformAdmin',
  params: z.object({ id: uuid }), response: obj,
  async handler(c) {
    const org = await c.trx('organizations').where({ id: c.params.id }).first();
    if (!org) throw new AppError('NOT_FOUND', 'Organization not found');
    const checks: { check: string; ok: boolean; detail?: string }[] = [];
    const owner = org.owner_user_id ? await c.trx('users').where({ id: org.owner_user_id }).first() : null;
    checks.push({ check: 'owner_exists_and_active', ok: !!owner && owner.status === 'active' });
    const admins = await c.trx('user_role_assignments').where({ organization_id: org.id, role_id: '00000000-0000-7000-8000-000000000001' }).count({ c: '*' }).first();
    checks.push({ check: 'has_organization_admin', ok: Number((admins as { c: string }).c) > 0 });
    checks.push({ check: 'status_active', ok: org.status === 'active', detail: org.status });
    const usage = await c.trx('storage_usage').where({ organization_id: org.id }).first();
    checks.push({ check: 'storage_usage_row', ok: !!usage });
    checks.push({ check: 'timezone_valid', ok: (() => { try { new Intl.DateTimeFormat('en', { timeZone: org.timezone }); return true; } catch { return false; } })() });
    return { data: { ok: checks.every((x) => x.ok), checks } };
  },
});

defineRoute({
  method: 'get', path: '/platform/tenants/:id/quotas', module: M, moduleFlag: FLAG, summary: 'Tenant quotas', access: 'platformAdmin', params: z.object({ id: uuid }), response: obj,
  async handler(c) {
    const rows = await c.trx('organization_settings').where({ organization_id: c.params.id }).whereIn('key', ['storage.quota_bytes']);
    return { data: Object.fromEntries(rows.map((r) => [r.key, r.value])) };
  },
});

defineRoute({
  method: 'put', path: '/platform/tenants/:id/quotas', module: M, moduleFlag: FLAG, summary: 'Set tenant quotas', access: 'platformAdmin', params: z.object({ id: uuid }),
  body: z.object({ storageBytes: z.number().int().min(1_000_000).max(10 ** 13) }), response: obj,
  async handler(c) {
    await c.trx('organization_settings').insert({ organization_id: c.params.id, key: 'storage.quota_bytes', value: JSON.stringify(c.body.storageBytes), updated_by: c.auth!.userId })
      .onConflict(['organization_id', 'key']).merge({ value: JSON.stringify(c.body.storageBytes), updated_by: c.auth!.userId, updated_at: c.svc.now() });
    await recordAudit(c.trx, { ...c.meta, organizationId: c.params.id }, { action: 'platform.quota_changed', resourceType: 'organization', resourceId: c.params.id, metadata: { storageBytes: c.body.storageBytes } });
    return { status: 200, data: { storageBytes: c.body.storageBytes } };
  },
});

defineRoute({
  method: 'put', path: '/platform/tenants/:id/plan', module: M, moduleFlag: FLAG, summary: 'Assign a plan to a tenant', access: 'platformAdmin',
  params: z.object({ id: uuid }), body: z.object({ planKey: z.string().max(40) }), response: obj,
  async handler(c) {
    const plan = await c.trx('plans').where({ key: c.body.planKey }).first();
    if (!plan) throw new AppError('NOT_FOUND', 'Plan not found');
    const n = await c.trx('organizations').where({ id: c.params.id }).update({ plan_key: plan.key, updated_at: c.svc.now() });
    if (!n) throw new AppError('NOT_FOUND', 'Organization not found');
    await recordAudit(c.trx, { ...c.meta, organizationId: c.params.id }, { action: 'platform.plan_assigned', resourceType: 'organization', resourceId: c.params.id, metadata: { plan: plan.key } });
    return { status: 200, data: { organizationId: c.params.id, planKey: plan.key } };
  },
});

defineRoute({
  method: 'get', path: '/platform/diagnostics/:requestId', module: M, moduleFlag: FLAG, summary: 'Trace a request id across audit and security logs',
  access: 'platformAdmin', params: z.object({ requestId: z.string().regex(/^[\w.-]{8,128}$/) }), response: obj,
  async handler(c) {
    const audit = await c.trx('audit_events').where({ correlation_id: c.params.requestId }).orderBy('occurred_at').limit(100)
      .select('occurred_at', 'organization_id', 'actor_id', 'action', 'resource_type', 'outcome');
    const security = await c.trx('security_events').where({ correlation_id: c.params.requestId }).orderBy('occurred_at').limit(100)
      .select('occurred_at', 'organization_id', 'event', 'outcome');
    return { data: { requestId: c.params.requestId, audit: audit.map((r) => rowToApi(r)), security: security.map((r) => rowToApi(r)) } };
  },
});

// ---- alerts + provisioning visibility + backups ---------------------------------------------------------------------------------

defineRoute({
  method: 'post', path: '/platform/alerts', module: M, moduleFlag: FLAG, summary: 'Raise an operational alert', access: 'platformAdmin',
  body: z.object({ severity: z.enum(['info', 'warning', 'critical']), title: z.string().trim().min(3).max(200), detail: z.string().max(2000).optional(), organizationId: uuid.optional() }),
  response: obj,
  async handler(c) {
    const id = newId();
    await c.trx('operational_alerts').insert({ id, organization_id: c.body.organizationId ?? null, severity: c.body.severity, title: c.body.title, detail: c.body.detail ?? null });
    return { status: 201, data: { id, status: 'open' } };
  },
});

defineRoute({
  method: 'get', path: '/platform/alerts', module: M, moduleFlag: FLAG, summary: 'Operational alerts', access: 'platformAdmin', query: listQuerySchema, response: obj,
  async handler(c) {
    const page = await paginate(c.trx('operational_alerts'), c.query as ListQuery, { sortable: { created_at: 'created_at' }, filterable: { status: 'status', severity: 'severity' }, defaultSort: '-created_at' });
    return { data: page.data.map((r) => rowToApi(r)), meta: page.meta };
  },
});

for (const [verb, status] of [['acknowledge', 'acknowledged'], ['resolve', 'resolved']] as const) {
  defineRoute({
    method: 'post', path: `/platform/alerts/:id/${verb}`, module: M, moduleFlag: FLAG, summary: `${verb} an alert`, access: 'platformAdmin',
    params: z.object({ id: uuid }), response: obj,
    async handler(c) {
      const n = await c.trx('operational_alerts').where({ id: c.params.id }).whereNot('status', 'resolved')
        .update({ status, acknowledged_by: c.auth!.userId, acknowledged_at: c.svc.now() });
      if (!n) throw new AppError('NOT_FOUND', 'Open alert not found');
      return { status: 200, data: { id: c.params.id, status } };
    },
  });
}

defineRoute({
  method: 'get', path: '/platform/provisioning-jobs', module: M, moduleFlag: FLAG, summary: 'Tenant provisioning attempts', access: 'platformAdmin', query: listQuerySchema, response: obj,
  async handler(c) {
    const page = await paginate(c.trx('tenant_provisioning_jobs'), c.query as ListQuery, { sortable: { created_at: 'created_at' }, filterable: { status: 'status' }, defaultSort: '-created_at' });
    return { data: page.data.map((r) => rowToApi(r)), meta: page.meta };
  },
});

defineRoute({
  method: 'post', path: '/platform/tenants/:id/first-admin', module: M, moduleFlag: FLAG, summary: 'Issue a one-time setup link for the first administrator',
  access: 'platformAdmin', params: z.object({ id: uuid }), response: obj, idempotent: true,
  async handler(c) {
    const org = await c.trx('organizations').where({ id: c.params.id }).first();
    if (!org?.owner_user_id) throw new AppError('NOT_FOUND', 'Organization not found');
    const owner = await c.trx('users').where({ id: org.owner_user_id }).first();
    if (owner.password_hash) throw new AppError('CONFLICT', 'The first administrator already has a password');
    const token = randomToken();
    await c.trx('verification_tokens').insert({ id: newId(), user_id: owner.id, purpose: 'password_reset', token_hash: sha256(token), expires_at: new Date(c.svc.now().getTime() + 48 * 3600_000) });
    await c.svc.mail.send({ to: owner.email, subject: 'Set up your administrator account', text: `Set your password with this token: ${token}` });
    await recordAudit(c.trx, { ...c.meta, organizationId: org.id }, { action: 'platform.first_admin_link_issued', resourceType: 'organization', resourceId: org.id });
    return { status: 200, data: { organizationId: org.id, sentTo: owner.email } };
  },
});

defineRoute({
  method: 'post', path: '/platform/backups', module: 'platform', summary: 'Record a backup run (called by scripts/backup.sh)', access: 'platformAdmin',
  body: z.object({ status: z.enum(['completed', 'failed']), location: z.string().max(300).optional(), sizeBytes: z.number().int().min(0).optional() }), response: obj,
  async handler(c) {
    const id = newId();
    await c.trx('backup_runs').insert({ id, status: c.body.status, location: c.body.location ?? null, size_bytes: c.body.sizeBytes ?? null, finished_at: c.svc.now() });
    return { status: 201, data: { id } };
  },
});

defineRoute({
  method: 'get', path: '/platform/backups', module: 'platform', summary: 'Backup history and last success', access: 'platformAdmin', response: obj,
  async handler(c) {
    const rows = await c.trx('backup_runs').orderBy('started_at', 'desc').limit(30);
    const last = rows.find((r) => r.status === 'completed');
    return { data: { lastSuccessfulAt: last?.finished_at ? new Date(last.finished_at).toISOString() : null, runs: rows.map((r) => rowToApi(r)) } };
  },
});

// platform housekeeping: open an alert when the last backup is stale
jobRegistrars.push((svc) => {
  svc.jobs.work('retention', async () => {
    await withPlatformScope(svc.db, 'backup-staleness', async (t) => {
      const last = await t('backup_runs').where({ status: 'completed' }).max({ at: 'finished_at' }).first();
      const at = (last as { at: Date | null }).at;
      if (at && Date.now() - new Date(at).getTime() > 36 * 3600_000) {
        const open = await t('operational_alerts').where({ title: 'Backups are stale', status: 'open' }).first();
        if (!open) await t('operational_alerts').insert({ id: newId(), severity: 'critical', title: 'Backups are stale', detail: 'No successful backup in the last 36 hours' });
      }
    });
  });
});

void provisionOrganization;
