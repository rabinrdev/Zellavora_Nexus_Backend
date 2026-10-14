import { z } from 'zod';
import { defineRoute } from '../../platform/http/route.js';
import { AppError } from '../../platform/errors.js';
import { crudResource } from '../../platform/crud.js';
import { isFlagEnabled } from '../../platform/flags.js';
import { registerExportKind, requestExport } from '../data/exports.js';
import { allReports, allWidgets, getReport, getWidget, registerReport, registerWidget, type WidgetCtx } from './registry.js';

const M = 'dashboard';
const obj = z.record(z.string(), z.unknown());

const rangeQuery = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  granularity: z.enum(['day', 'week', 'month']).default('day'),
});

function range(q: z.infer<typeof rangeQuery>, now: Date) {
  const to = q.to ? new Date(q.to) : now;
  const from = q.from ? new Date(q.from) : new Date(to.getTime() - 30 * 86400_000);
  if (from >= to) throw new AppError('VALIDATION_FAILED', 'from must be before to', [{ field: 'from', issue: 'after to' }]);
  if (to.getTime() - from.getTime() > 366 * 86400_000) throw new AppError('VALIDATION_FAILED', 'Range too large (max 366 days)', [{ field: 'from', issue: 'range too large' }]);
  return { from, to };
}

// ---- built-in widgets (each maps to a real decision; F-026/F-027/F-030) ---------------------------------------------

registerWidget({
  key: 'members.summary', title: 'Members', requiredPermission: 'users:read',
  async query({ trx, organizationId }) {
    const rows = (await trx('organization_memberships').where({ organization_id: organizationId }).whereNot('status', 'removed').select('status').count({ c: '*' }).groupBy('status')) as unknown as { status: string; c: string }[];
    const invites = await trx('invitations').where({ organization_id: organizationId, status: 'pending' }).count({ c: '*' }).first();
    return { byStatus: Object.fromEntries(rows.map((r) => [r.status, Number(r.c)])), pendingInvitations: Number((invites as { c: string }).c) };
  },
});

registerWidget({
  key: 'activity.recent', title: 'Recent activity', requiredPermission: 'audit:read',
  async query({ trx, organizationId }) {
    const rows = await trx('audit_events').where({ organization_id: organizationId }).orderBy('occurred_at', 'desc').limit(10)
      .select('id', 'occurred_at', 'actor_id', 'action', 'resource_type', 'resource_id', 'outcome');
    return rows.map((r) => ({ ...r, occurred_at: new Date(r.occurred_at).toISOString() }));
  },
});

registerWidget({
  key: 'activity.trend', title: 'Activity over time', requiredPermission: 'audit:read',
  async query({ trx, organizationId, from, to, granularity }: WidgetCtx) {
    const unit = { day: 'day', week: 'week', month: 'month' }[granularity];
    const rows = (await trx('audit_events').where({ organization_id: organizationId }).whereBetween('occurred_at', [from, to])
      .select(trx.raw(`date_trunc('${unit}', occurred_at) AS bucket`)).count({ c: '*' }).groupBy('bucket').orderBy('bucket')) as unknown as { bucket: string; c: string }[];
    return rows.map((r) => ({ bucket: new Date(r.bucket as string).toISOString(), count: Number(r.c) }));
  },
});

registerWidget({
  key: 'access.pending_requests', title: 'Pending access requests', requiredPermission: 'access_requests:approve',
  async query({ trx, organizationId }) {
    const r = await trx('access_requests').where({ organization_id: organizationId, status: 'pending' }).count({ c: '*' }).first();
    return { pending: Number((r as { c: string }).c) };
  },
});

registerWidget({
  key: 'storage.usage', title: 'Storage', requiredPermission: 'files:read',
  async query({ trx, svc, organizationId }) {
    const u = await trx('storage_usage').where({ organization_id: organizationId }).first();
    const q = await trx('organization_settings').where({ organization_id: organizationId, key: 'storage.quota_bytes' }).first();
    return { usedBytes: Number(u?.bytes_used ?? 0), quotaBytes: typeof q?.value === 'number' ? q.value : svc.env.STORAGE_QUOTA_BYTES };
  },
});

// ---- built-in reports -------------------------------------------------------------------------------------------

registerReport({
  key: 'members', title: 'Members', requiredPermission: 'users:read',
  async run({ trx, organizationId }) {
    return trx('organization_memberships as m').join('users as u', 'u.id', 'm.user_id').where('m.organization_id', organizationId)
      .whereNot('m.status', 'removed').orderBy('u.email').select('u.email', 'u.name', 'm.status', 'm.joined_at');
  },
});

registerReport({
  key: 'audit_summary', title: 'Audit summary by action', requiredPermission: 'audit:read',
  async run({ trx, organizationId, params }) {
    const q = trx('audit_events').where({ organization_id: organizationId });
    if (params.from) q.where('occurred_at', '>=', params.from);
    if (params.to) q.where('occurred_at', '<=', params.to);
    return q.select('action', 'outcome').count({ events: '*' }).groupBy('action', 'outcome').orderBy('events', 'desc').limit(1000);
  },
});

for (const r of allReports()) {
  registerExportKind(`report.${r.key}`, {
    permission: 'reports:export', formats: ['csv', 'xlsx', 'json'],
    async generate(svc, trx, ctx) {
      const rows = await r.run({ trx, svc, organizationId: ctx.organizationId, userId: ctx.userId ?? '', params: ctx.params as Record<string, string> });
      return { rows, filename: `report-${r.key}` };
    },
  });
}

// ---- routes -----------------------------------------------------------------------------------------------------

defineRoute({
  method: 'get', path: '/dashboard', module: M, summary: 'Role-aware dashboard composition',
  access: { permission: 'dashboard:read' }, query: rangeQuery, response: obj,
  async handler(c) {
    const { from, to } = range(c.query, c.svc.now());
    const out: { key: string; title: string; state: 'ok' | 'module_not_enabled'; data?: unknown }[] = [];
    for (const w of allWidgets()) {
      if (!c.auth!.permissions.has(w.requiredPermission)) continue; // permission and module must both allow (F-200)
      if (w.requiredModuleFlag && !(await isFlagEnabled(c.trx, w.requiredModuleFlag, { organizationId: c.orgId(), userId: c.auth!.userId }))) {
        out.push({ key: w.key, title: w.title, state: 'module_not_enabled' });
        continue;
      }
      out.push({ key: w.key, title: w.title, state: 'ok', data: await w.query({ trx: c.trx, svc: c.svc, organizationId: c.orgId(), userId: c.auth!.userId, from, to, granularity: c.query.granularity }) });
    }
    return { data: { widgets: out } };
  },
});

defineRoute({
  method: 'get', path: '/dashboard/widgets/:key', module: M, summary: 'One widget with date range and granularity (drill-down)',
  access: { permission: 'dashboard:read' }, params: z.object({ key: z.string().max(80) }), query: rangeQuery, response: obj,
  async handler(c) {
    const w = getWidget(c.params.key);
    if (!w || !c.auth!.permissions.has(w.requiredPermission)) throw new AppError('NOT_FOUND', 'Widget not found');
    if (w.requiredModuleFlag && !(await isFlagEnabled(c.trx, w.requiredModuleFlag, { organizationId: c.orgId(), userId: c.auth!.userId }))) {
      return { data: { key: w.key, state: 'module_not_enabled' } };
    }
    const { from, to } = range(c.query, c.svc.now());
    return { data: { key: w.key, state: 'ok', from: from.toISOString(), to: to.toISOString(), data: await w.query({ trx: c.trx, svc: c.svc, organizationId: c.orgId(), userId: c.auth!.userId, from, to, granularity: c.query.granularity }) } };
  },
});

defineRoute({
  method: 'get', path: '/reports', module: M, summary: 'Reports available to the caller', access: { permission: 'reports:read' }, response: obj,
  async handler(c) {
    return { data: allReports().filter((r) => c.auth!.permissions.has(r.requiredPermission)).map((r) => ({ key: r.key, title: r.title })) };
  },
});

defineRoute({
  method: 'get', path: '/reports/:key', module: M, summary: 'Run a report (capped at 5000 rows)',
  access: { permission: 'reports:read' }, params: z.object({ key: z.string().max(80) }),
  query: z.object({ from: z.string().datetime().optional(), to: z.string().datetime().optional() }), response: obj,
  async handler(c) {
    const r = getReport(c.params.key);
    if (!r || !c.auth!.permissions.has(r.requiredPermission)) throw new AppError('NOT_FOUND', 'Report not found');
    if (r.requiredModuleFlag && !(await isFlagEnabled(c.trx, r.requiredModuleFlag, { organizationId: c.orgId() }))) {
      return { data: { state: 'module_not_enabled', rows: [] } };
    }
    const rows = await r.run({ trx: c.trx, svc: c.svc, organizationId: c.orgId(), userId: c.auth!.userId, params: c.query });
    return { data: { state: 'ok', rows: rows.slice(0, 5000), truncated: rows.length > 5000 } };
  },
});

defineRoute({
  method: 'post', path: '/reports/:key/export', module: M, summary: 'Export a report (async)',
  access: { permission: 'reports:export' }, params: z.object({ key: z.string().max(80) }), idempotent: true,
  body: z.object({ format: z.enum(['csv', 'xlsx', 'json']).default('csv'), from: z.string().datetime().optional(), to: z.string().datetime().optional() }),
  response: obj, audit: { action: 'report.exported', resourceType: 'report' },
  async handler(c) {
    const r = getReport(c.params.key);
    if (!r || !c.auth!.permissions.has(r.requiredPermission)) throw new AppError('NOT_FOUND', 'Report not found');
    const { format, ...params } = c.body;
    return { status: 202, data: await requestExport(c, `report.${r.key}`, format, params), auditResourceId: r.key };
  },
});

crudResource({
  module: M, path: '/dashboard/views', table: 'saved_dashboard_views', resource: 'dashboard', rowVersion: true,
  create: z.object({ name: z.string().trim().min(1).max(80), filters: z.record(z.string(), z.unknown()).default({}) }),
  list: { sortable: { created_at: 'saved_dashboard_views.created_at', name: 'saved_dashboard_views.name' }, defaultSort: 'name' },
  hooks: {
    scope: (c, qb) => void qb.where('saved_dashboard_views.user_id', c.auth!.userId),
    beforeCreate: async (c) => ({ user_id: c.auth!.userId }),
  },
});
