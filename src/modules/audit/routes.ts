import { z } from 'zod';
import { defineRoute } from '../../platform/http/route.js';
import { AppError } from '../../platform/errors.js';
import { paginate, listQuerySchema, type ListQuery } from '../../platform/pagination.js';
import { rowToApi } from '../../platform/crud.js';
import { requestExport } from '../data/exports.js';

const M = 'audit';
const obj = z.record(z.string(), z.unknown());

const auditQuery = listQuerySchema.extend({
  actorId: z.string().uuid().optional(),
  action: z.string().max(120).optional(),
  resourceType: z.string().max(80).optional(),
  resourceId: z.string().max(80).optional(),
  outcome: z.enum(['success', 'failure', 'denied']).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

const dto = (r: Record<string, unknown>) => rowToApi(r);

defineRoute({
  method: 'get', path: '/audit-events', module: M, summary: 'Search audit events', access: { permission: 'audit:read' },
  query: auditQuery, response: obj,
  async handler(c) {
    const q = c.query as z.infer<typeof auditQuery>;
    const qb = c.trx('audit_events').where({ organization_id: c.orgId() });
    if (q.actorId) qb.where({ actor_id: q.actorId });
    if (q.action) qb.where('action', 'like', `${q.action.replace(/[%_\\]/g, '\\$&')}%`);
    if (q.resourceType) qb.where({ resource_type: q.resourceType });
    if (q.resourceId) qb.where({ resource_id: q.resourceId });
    if (q.outcome) qb.where({ outcome: q.outcome });
    if (q.from) qb.where('occurred_at', '>=', q.from);
    if (q.to) qb.where('occurred_at', '<=', q.to);
    const page = await paginate(qb, q as ListQuery, {
      sortable: { occurred_at: 'occurred_at', action: 'action' }, filterable: {}, defaultSort: '-occurred_at',
    });
    return { data: page.data.map(dto), meta: page.meta };
  },
});

defineRoute({
  method: 'get', path: '/audit-events/:id', module: M, summary: 'Get an audit event', access: { permission: 'audit:read' },
  params: z.object({ id: z.string().uuid() }), response: obj,
  async handler(c) {
    const r = await c.trx('audit_events').where({ id: c.params.id, organization_id: c.orgId() }).first();
    if (!r) throw new AppError('NOT_FOUND', 'Audit event not found');
    return { data: dto(r) };
  },
});

defineRoute({
  method: 'post', path: '/audit-events/export', module: M, summary: 'Export audit events (controlled, itself audited)',
  access: { permission: 'audit:export' }, idempotent: true,
  body: z.object({ format: z.enum(['csv', 'json']).default('csv'), from: z.string().datetime().optional(), to: z.string().datetime().optional(), action: z.string().max(120).optional() }),
  response: obj, audit: { action: 'audit.exported', resourceType: 'audit_events' },
  async handler(c) {
    const { format, ...params } = c.body;
    return { status: 202, data: await requestExport(c, 'audit', format, params) };
  },
});

defineRoute({
  method: 'get', path: '/security-events', module: M, summary: 'Security events (logins, lockouts, denials)',
  access: { permission: 'audit:read' }, query: listQuerySchema.extend({ event: z.string().max(80).optional() }), response: obj,
  async handler(c) {
    const q = c.query as { event?: string } & ListQuery;
    const qb = c.trx('security_events').where({ organization_id: c.orgId() });
    if (q.event) qb.where({ event: q.event });
    const page = await paginate(qb, q, { sortable: { occurred_at: 'occurred_at' }, filterable: { outcome: 'outcome' }, defaultSort: '-occurred_at' });
    return { data: page.data.map(dto), meta: page.meta };
  },
});

defineRoute({
  method: 'get', path: '/audit/retention-policy', module: M, summary: 'Audit retention policy', access: { permission: 'audit:manage' }, response: obj,
  async handler(c) {
    const p = await c.trx('audit_retention_policies').where({ organization_id: c.orgId() }).first();
    return { data: p ? dto(p) : { retentionDays: 365, legalHold: false, isDefault: true } };
  },
});

defineRoute({
  method: 'put', path: '/audit/retention-policy', module: M, summary: 'Set audit retention policy', access: { permission: 'audit:manage' },
  body: z.object({ retentionDays: z.number().int().min(30).max(3650), legalHold: z.boolean().default(false) }), response: obj,
  audit: { action: 'audit.retention_policy_changed', resourceType: 'audit_retention_policy' },
  async handler(c) {
    await c.trx('audit_retention_policies').insert({
      organization_id: c.orgId(), retention_days: c.body.retentionDays, legal_hold: c.body.legalHold, updated_by: c.auth!.userId,
    }).onConflict('organization_id').merge({ retention_days: c.body.retentionDays, legal_hold: c.body.legalHold, updated_by: c.auth!.userId, updated_at: c.svc.now() });
    return { status: 200, data: { retentionDays: c.body.retentionDays, legalHold: c.body.legalHold }, auditResourceId: c.orgId() };
  },
});
