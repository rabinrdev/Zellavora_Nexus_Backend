import { z } from 'zod';
import { defineRoute } from '../../platform/http/route.js';
import { AppError } from '../../platform/errors.js';
import { newId } from '../../platform/crypto.js';
import { paginate, listQuerySchema, type ListQuery } from '../../platform/pagination.js';
import { rowToApi } from '../../platform/crud.js';
import { QUEUES } from '../../platform/jobs.js';
import { provisionOrganization } from '../organizations/provision.js';
import { withPlatformScope } from '../../platform/scope.js';

const M = 'platform';
const obj = z.record(z.string(), z.unknown());
const idParams = z.object({ id: z.string().uuid() });

// ---- releases / deployments / incidents (F-164, F-177) ----------------------------------------------------------

defineRoute({
  method: 'get', path: '/platform/releases', module: M, summary: 'Release records', access: 'platformAdmin', query: listQuerySchema, response: obj,
  async handler(c) {
    const page = await paginate(c.trx('release_records'), c.query as ListQuery, { sortable: { released_at: 'released_at' }, defaultSort: '-released_at' });
    return { data: page.data.map((r) => rowToApi(r)), meta: page.meta };
  },
});

defineRoute({
  method: 'post', path: '/platform/releases', module: M, summary: 'Record a release', access: 'platformAdmin',
  body: z.object({ version: z.string().max(40), gitSha: z.string().max(64).optional(), notes: z.string().max(5000).optional() }), response: obj,
  async handler(c) {
    const id = newId();
    await c.trx('release_records').insert({ id, version: c.body.version, git_sha: c.body.gitSha ?? null, notes: c.body.notes ?? null });
    await c.audit({ action: 'platform.release_recorded', resourceType: 'release', resourceId: id, metadata: { version: c.body.version } });
    return { status: 201, data: { id, ...c.body } };
  },
});

defineRoute({
  method: 'post', path: '/platform/deployments', module: M, summary: 'Record a deployment', access: 'platformAdmin',
  body: z.object({ version: z.string().max(40), environment: z.enum(['staging', 'production']), status: z.enum(['started', 'succeeded', 'failed', 'rolled_back']), notes: z.string().max(2000).optional() }),
  response: obj,
  async handler(c) {
    const id = newId();
    await c.trx('deployment_records').insert({ id, version: c.body.version, environment: c.body.environment, status: c.body.status, notes: c.body.notes ?? null });
    return { status: 201, data: { id, ...c.body } };
  },
});

defineRoute({
  method: 'get', path: '/platform/deployments', module: M, summary: 'Deployment history', access: 'platformAdmin', query: listQuerySchema, response: obj,
  async handler(c) {
    const page = await paginate(c.trx('deployment_records'), c.query as ListQuery, { sortable: { deployed_at: 'deployed_at' }, defaultSort: '-deployed_at' });
    return { data: page.data.map((r) => rowToApi(r)), meta: page.meta };
  },
});

defineRoute({
  method: 'post', path: '/platform/incidents', module: M, summary: 'Open an incident', access: 'platformAdmin',
  body: z.object({ title: z.string().trim().min(3).max(200), severity: z.enum(['sev1', 'sev2', 'sev3', 'sev4']), summary: z.string().max(5000).optional() }),
  response: obj,
  async handler(c) {
    const id = newId();
    await c.trx('incident_records').insert({ id, title: c.body.title, severity: c.body.severity, summary: c.body.summary ?? null });
    return { status: 201, data: { id, status: 'open', ...c.body } };
  },
});

defineRoute({
  method: 'post', path: '/platform/incidents/:id/resolve', module: M, summary: 'Resolve an incident', access: 'platformAdmin', params: idParams, response: obj,
  async handler(c) {
    const n = await c.trx('incident_records').where({ id: c.params.id, status: 'open' }).update({ status: 'resolved', resolved_at: c.svc.now() });
    if (!n) throw new AppError('NOT_FOUND', 'Open incident not found');
    return { status: 200, data: { id: c.params.id, status: 'resolved' } };
  },
});

defineRoute({
  method: 'get', path: '/platform/incidents', module: M, summary: 'Incidents', access: 'platformAdmin', query: listQuerySchema, response: obj,
  async handler(c) {
    const page = await paginate(c.trx('incident_records'), c.query as ListQuery, { sortable: { created_at: 'created_at' }, filterable: { status: 'status' }, defaultSort: '-created_at' });
    return { data: page.data.map((r) => rowToApi(r)), meta: page.meta };
  },
});

// ---- jobs dashboard (F-163) ---------------------------------------------------------------------------------------

defineRoute({
  method: 'get', path: '/platform/jobs', module: M, summary: 'Background job runs', access: 'platformAdmin',
  query: listQuerySchema.extend({ queue: z.string().max(40).optional() }), response: obj,
  async handler(c) {
    const q = c.query as { queue?: string } & ListQuery;
    const qb = c.trx('job_runs');
    if (q.queue) qb.where({ queue: q.queue });
    const page = await paginate(qb, q, { sortable: { started_at: 'started_at' }, filterable: { status: 'status' }, defaultSort: '-started_at' });
    return { data: page.data.map((r) => rowToApi(r)), meta: { ...page.meta, queues: QUEUES } };
  },
});

// ---- tenant provisioning (F-141, F-239–F-241): idempotent + resumable -----------------------------------------------

defineRoute({
  method: 'post', path: '/platform/tenants', module: M, summary: 'Provision a tenant (idempotent, resumable)',
  access: 'platformAdmin', idempotent: 'required',
  body: z.object({
    name: z.string().trim().min(2).max(120), code: z.string().trim().toLowerCase().max(40).optional(),
    adminEmail: z.string().trim().toLowerCase().email().max(254), adminName: z.string().trim().min(1).max(120),
    planKey: z.string().max(40).optional(), // omitted = unmetered
  }),
  response: obj, audit: { action: 'platform.tenant_provisioned', resourceType: 'organization' },
  async handler(c) {
    const { randomToken, sha256 } = await import('../../platform/crypto.js');
    const jobId = newId();
    const steps: { step: string; at: string }[] = [];
    const mark = (step: string) => steps.push({ step, at: c.svc.now().toISOString() });
    const request = { name: c.body.name, code: c.body.code ?? null, adminEmail: c.body.adminEmail, planKey: c.body.planKey ?? null };
    try {
      let user = await c.trx('users').where({ email: c.body.adminEmail }).first();
      if (!user) {
        const id = newId();
        await c.trx('users').insert({ id, email: c.body.adminEmail, name: c.body.adminName });
        user = { id };
        mark('admin_user_created');
      } else mark('admin_user_reused');
      // all steps share one transaction: a failure leaves no half-created tenant (and the job row records why)
      const org = await provisionOrganization(c.trx, { name: c.body.name, code: c.body.code, type: 'business', ownerUserId: user.id });
      mark('organization_provisioned');
      if (c.body.planKey) await c.trx('organizations').where({ id: org.organizationId }).update({ plan_key: c.body.planKey });
      const token = randomToken();
      await c.trx('verification_tokens').insert({
        id: newId(), user_id: user.id, purpose: 'password_reset', token_hash: sha256(token), expires_at: new Date(c.svc.now().getTime() + 48 * 3600_000),
      });
      await c.trx('users').where({ id: user.id }).whereNull('email_verified_at').update({ email_verified_at: c.svc.now() });
      mark('first_admin_invited');
      await c.trx('tenant_provisioning_jobs').insert({
        id: jobId, organization_id: org.organizationId, requested_by: c.auth!.userId, request: JSON.stringify(request),
        status: 'completed', steps: JSON.stringify(steps), finished_at: c.svc.now(),
      });
      await c.svc.mail.send({ to: c.body.adminEmail, subject: 'Your organization is ready', text: `Set your password with this token: ${token}` });
      return { status: 201, data: { organizationId: org.organizationId, code: org.code, adminUserId: user.id, jobId }, auditResourceId: org.organizationId };
    } catch (e) {
      // the request transaction rolls back; the failure record is written on its own connection so it survives
      await withPlatformScope(c.svc.db, 'provisioning-failure', (t) => t('tenant_provisioning_jobs').insert({
        id: jobId, requested_by: c.auth!.userId, request: JSON.stringify(request), status: 'failed', steps: JSON.stringify(steps),
        error_summary: ((e as Error).message ?? 'error').slice(0, 300), finished_at: new Date(),
      })).catch(() => undefined);
      throw e;
    }
  },
});

defineRoute({
  method: 'get', path: '/platform/health', module: M, summary: 'Platform health summary', access: 'platformAdmin', response: obj,
  async handler(c) {
    const orgs = (await c.trx('organizations').select('status').count({ c: '*' }).groupBy('status')) as unknown as { status: string; c: string }[];
    const failedJobs = await c.trx('job_runs').where('started_at', '>', new Date(Date.now() - 86400_000)).whereIn('status', ['failed', 'dead_letter']).count({ c: '*' }).first();
    return { data: { organizationsByStatus: Object.fromEntries(orgs.map((o) => [o.status, Number(o.c)])), failedJobsLast24h: Number((failedJobs as { c: string }).c) } };
  },
});
