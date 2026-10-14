import { z } from 'zod';
import type { Knex } from 'knex';
import { defineRoute } from '../../platform/http/route.js';
import { AppError } from '../../platform/errors.js';
import { newId } from '../../platform/crypto.js';
import { crudResource, rowToApi } from '../../platform/crud.js';
import { jobRegistrars } from '../../platform/job-handlers.js';
import { withPlatformScope, withTenant, type Trx } from '../../platform/scope.js';
import { registerExportKind, requestExport } from '../data/exports.js';
import { saveFile } from '../../platform/files.js';
import { renderExport } from '../data/exports.js';
import type { Services } from '../../platform/types.js';

const M = 'advanced_reports';
const FLAG = 'module.reports';
const obj = z.record(z.string(), z.unknown());
const uuid = z.string().uuid();

type FieldType = 'string' | 'number' | 'date' | 'boolean';
interface Field { column: string; type: FieldType; groupable?: boolean; aggregatable?: boolean; permission?: string }
interface Dataset { table: string; permission: string; softDelete?: boolean; fields: Record<string, Field> }

/** The ONLY source of identifiers that can reach SQL. Clients send field names; columns come from here. */
export const DATASETS: Record<string, Dataset> = {
  projects: {
    table: 'projects', permission: 'projects:read', softDelete: true,
    fields: {
      name: { column: 'name', type: 'string', groupable: true }, status: { column: 'status', type: 'string', groupable: true },
      owner_id: { column: 'owner_id', type: 'string', groupable: true }, start_date: { column: 'start_date', type: 'date', groupable: true },
      end_date: { column: 'end_date', type: 'date' }, budget_hours: { column: 'budget_hours', type: 'number', aggregatable: true },
      created_at: { column: 'created_at', type: 'date' },
    },
  },
  tasks: {
    table: 'tasks', permission: 'tasks:read', softDelete: true,
    fields: {
      project_id: { column: 'project_id', type: 'string', groupable: true }, status: { column: 'status', type: 'string', groupable: true },
      priority: { column: 'priority', type: 'string', groupable: true }, assignee_id: { column: 'assignee_id', type: 'string', groupable: true },
      due_date: { column: 'due_date', type: 'date', groupable: true }, estimate_hours: { column: 'estimate_hours', type: 'number', aggregatable: true },
      created_at: { column: 'created_at', type: 'date' },
    },
  },
  time_entries: {
    table: 'time_entries', permission: 'timesheets:review',
    fields: {
      user_id: { column: 'user_id', type: 'string', groupable: true }, project_id: { column: 'project_id', type: 'string', groupable: true },
      work_date: { column: 'work_date', type: 'date', groupable: true }, minutes: { column: 'minutes', type: 'number', aggregatable: true },
      billable: { column: 'billable', type: 'boolean', groupable: true },
    },
  },
  invoices: {
    table: 'invoices', permission: 'invoices:read',
    fields: {
      status: { column: 'status', type: 'string', groupable: true }, customer_id: { column: 'customer_id', type: 'string', groupable: true },
      currency: { column: 'currency', type: 'string', groupable: true }, issue_date: { column: 'issue_date', type: 'date', groupable: true },
      due_date: { column: 'due_date', type: 'date', groupable: true },
      total: { column: 'total', type: 'number', aggregatable: true }, balance: { column: 'balance', type: 'number', aggregatable: true },
      amount_paid: { column: 'amount_paid', type: 'number', aggregatable: true, permission: 'payments:read' },
    },
  },
  leads: {
    table: 'leads', permission: 'leads:read', softDelete: true,
    fields: {
      status: { column: 'status', type: 'string', groupable: true }, source: { column: 'source', type: 'string', groupable: true },
      owner_id: { column: 'owner_id', type: 'string', groupable: true }, created_at: { column: 'created_at', type: 'date' },
    },
  },
};

const OPS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'contains', 'is_null'] as const;
const AGGS = ['count', 'sum', 'avg', 'min', 'max'] as const;

export const definitionSchema = z.object({
  dataset: z.string().max(40),
  fields: z.array(z.string().max(60)).max(20).default([]),
  filters: z.array(z.object({ field: z.string().max(60), op: z.enum(OPS), value: z.unknown().optional() })).max(20).default([]),
  groupBy: z.array(z.string().max(60)).max(5).default([]),
  aggregations: z.array(z.object({ fn: z.enum(AGGS), field: z.string().max(60).optional(), as: z.string().regex(/^[a-z][a-z0-9_]{0,30}$/).optional() })).max(10).default([]),
  orderBy: z.object({ field: z.string().max(60), direction: z.enum(['asc', 'desc']).default('asc') }).optional(),
  limit: z.number().int().min(1).max(5000).default(1000),
});
export type ReportDefinition = z.infer<typeof definitionSchema>;

function coerce(f: Field, v: unknown, field: string): unknown {
  const bad = () => new AppError('VALIDATION_FAILED', 'Invalid filter value', [{ field, issue: `expected ${f.type}` }]);
  if (f.type === 'number') { const n = Number(v); if (Number.isNaN(n)) throw bad(); return n; }
  if (f.type === 'boolean') { if (v === true || v === 'true') return true; if (v === false || v === 'false') return false; throw bad(); }
  if (f.type === 'date') { if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) throw bad(); return v; }
  if (typeof v !== 'string') throw bad();
  return v;
}

/** Compiles a validated definition to parameterized SQL. Raw SQL from clients is impossible by construction. */
export function compileReport(trx: Knex | Trx, def: ReportDefinition, ctx: { orgId: string; perms: ReadonlySet<string> }): Knex.QueryBuilder {
  const ds = DATASETS[def.dataset];
  if (!ds) throw new AppError('VALIDATION_FAILED', 'Unknown dataset', [{ field: 'dataset', issue: 'unknown' }]);
  if (!ctx.perms.has(ds.permission)) throw new AppError('FORBIDDEN', 'You do not have permission to perform this action');
  const field = (name: string, where: string): Field => {
    const f = ds.fields[name];
    if (!f) throw new AppError('VALIDATION_FAILED', 'Unknown field', [{ field: where, issue: `"${name}" is not available in ${def.dataset}` }]);
    if (f.permission && !ctx.perms.has(f.permission)) throw new AppError('FORBIDDEN', 'You do not have permission to perform this action', [{ field: where, issue: name }]);
    return f;
  };
  const qb = trx(ds.table).where(`${ds.table}.organization_id`, ctx.orgId);
  if (ds.softDelete) qb.whereNull(`${ds.table}.deleted_at`);
  const grouped = def.groupBy.length > 0 || def.aggregations.length > 0;
  if (!grouped && def.fields.length === 0) throw new AppError('VALIDATION_FAILED', 'Select at least one field or aggregation', [{ field: 'fields', issue: 'empty' }]);

  const selected: string[] = [];
  const groupCols: string[] = [];
  for (const g of def.groupBy) {
    const f = field(g, 'groupBy');
    if (!f.groupable) throw new AppError('VALIDATION_FAILED', 'Field cannot be grouped', [{ field: 'groupBy', issue: g }]);
    groupCols.push(`${ds.table}.${f.column}`);
    qb.select({ [g]: `${ds.table}.${f.column}` });
    selected.push(g);
  }
  if (grouped) {
    for (const fld of def.fields) if (!def.groupBy.includes(fld)) throw new AppError('VALIDATION_FAILED', 'Non-aggregated fields must be grouped', [{ field: 'fields', issue: fld }]);
  } else {
    for (const fld of def.fields) { const f = field(fld, 'fields'); qb.select({ [fld]: `${ds.table}.${f.column}` }); selected.push(fld); }
  }
  for (const [i, a] of def.aggregations.entries()) {
    const alias = a.as ?? `${a.fn}_${a.field ?? 'rows'}`;
    if (a.fn === 'count') { qb.select(trx.raw('count(*)::bigint AS ??', [alias])); selected.push(alias); continue; }
    if (!a.field) throw new AppError('VALIDATION_FAILED', 'Aggregation needs a field', [{ field: `aggregations.${i}`, issue: 'field required' }]);
    const f = field(a.field, `aggregations.${i}.field`);
    if (!f.aggregatable && !(a.fn === 'min' || a.fn === 'max')) throw new AppError('VALIDATION_FAILED', 'Field cannot be aggregated', [{ field: `aggregations.${i}.field`, issue: a.field }]);
    qb.select(trx.raw(`${a.fn}(??) AS ??`, [`${ds.table}.${f.column}`, alias]));
    selected.push(alias);
  }
  if (groupCols.length) qb.groupBy(groupCols);

  for (const [i, flt] of def.filters.entries()) {
    const f = field(flt.field, `filters.${i}.field`);
    const col = `${ds.table}.${f.column}`;
    switch (flt.op) {
      case 'eq': qb.where(col, coerce(f, flt.value, `filters.${i}.value`) as never); break;
      case 'neq': qb.whereNot(col, coerce(f, flt.value, `filters.${i}.value`) as never); break;
      case 'gt': qb.where(col, '>', coerce(f, flt.value, `filters.${i}.value`) as never); break;
      case 'gte': qb.where(col, '>=', coerce(f, flt.value, `filters.${i}.value`) as never); break;
      case 'lt': qb.where(col, '<', coerce(f, flt.value, `filters.${i}.value`) as never); break;
      case 'lte': qb.where(col, '<=', coerce(f, flt.value, `filters.${i}.value`) as never); break;
      case 'in': {
        if (!Array.isArray(flt.value) || flt.value.length === 0 || flt.value.length > 100) throw new AppError('VALIDATION_FAILED', 'in requires 1-100 values', [{ field: `filters.${i}.value`, issue: 'invalid' }]);
        qb.whereIn(col, flt.value.map((v) => coerce(f, v, `filters.${i}.value`)) as never[]);
        break;
      }
      case 'contains':
        if (f.type !== 'string') throw new AppError('VALIDATION_FAILED', 'contains needs a string field', [{ field: `filters.${i}.op`, issue: 'invalid' }]);
        qb.whereILike(col, `%${String(flt.value ?? '').replace(/[%_\\]/g, '\\$&')}%`);
        break;
      case 'is_null': qb.whereNull(col); break;
    }
  }
  if (def.orderBy) {
    if (selected.includes(def.orderBy.field)) qb.orderBy(def.orderBy.field, def.orderBy.direction);
    else throw new AppError('VALIDATION_FAILED', 'orderBy must be a selected column', [{ field: 'orderBy.field', issue: def.orderBy.field }]);
  }
  return qb.limit(def.limit);
}

export async function runReport(trx: Trx, def: ReportDefinition, ctx: { orgId: string; perms: ReadonlySet<string> }) {
  await trx.raw(`SET LOCAL statement_timeout = '8s'`); // bounded query time
  return compileReport(trx, def, ctx);
}

// ---- routes --------------------------------------------------------------------------------------------------------------

defineRoute({
  method: 'get', path: '/report-datasets', module: M, moduleFlag: FLAG, summary: 'Datasets, fields and aggregations the caller may use',
  access: { permission: 'reports:read' }, response: obj,
  async handler(c) {
    return {
      data: Object.entries(DATASETS).filter(([, d]) => c.auth!.permissions.has(d.permission)).map(([key, d]) => ({
        key, fields: Object.entries(d.fields).filter(([, f]) => !f.permission || c.auth!.permissions.has(f.permission))
          .map(([name, f]) => ({ name, type: f.type, groupable: !!f.groupable, aggregatable: !!f.aggregatable })),
        operators: OPS, aggregations: AGGS,
      })),
    };
  },
});

defineRoute({
  method: 'post', path: '/reports/run', module: M, moduleFlag: FLAG, summary: 'Run an ad-hoc report definition',
  access: { permission: 'reports:read' }, entitlement: { key: 'advanced_reports' }, body: definitionSchema, response: obj,
  async handler(c) {
    const rows = await runReport(c.trx, c.body, { orgId: c.orgId(), perms: c.auth!.permissions });
    return { status: 200, data: { rows, count: rows.length, truncated: rows.length >= c.body.limit } };
  },
});

crudResource({
  module: M, moduleFlag: FLAG, path: '/saved-reports', table: 'saved_reports', resource: 'saved_reports', rowVersion: true,
  create: z.object({ name: z.string().trim().min(2).max(120), definition: definitionSchema, shared: z.boolean().default(false) }),
  list: { sortable: { name: 'saved_reports.name', created_at: 'saved_reports.created_at' }, defaultSort: 'name' },
  hooks: {
    scope: (c, qb) => void qb.where((w) => w.where('saved_reports.owner_id', c.auth!.userId).orWhere('saved_reports.shared', true)),
    beforeCreate: async (c, _t, input) => {
      const def = (input as { definition: ReportDefinition }).definition;
      compileReport(c.trx, def, { orgId: c.orgId(), perms: c.auth!.permissions }); // validate eagerly
      return { owner_id: c.auth!.userId };
    },
  },
});

crudResource({
  module: M, moduleFlag: FLAG, path: '/saved-filters', table: 'saved_filters', resource: 'saved_reports',
  create: z.object({ dataset: z.string().max(40), name: z.string().trim().min(2).max(120), filters: definitionSchema.shape.filters }),
  list: { sortable: { name: 'saved_filters.name' }, defaultSort: 'name' },
  hooks: {
    scope: (c, qb) => void qb.where('saved_filters.owner_id', c.auth!.userId),
    beforeCreate: async (c, _t, input) => {
      if (!DATASETS[(input as { dataset: string }).dataset]) throw new AppError('VALIDATION_FAILED', 'Unknown dataset', [{ field: 'dataset', issue: 'unknown' }]);
      return { owner_id: c.auth!.userId };
    },
  },
});

// ---- exports + schedules ---------------------------------------------------------------------------------------------------

registerExportKind('adhoc_report', {
  permission: 'reports:export', formats: ['csv', 'xlsx', 'json'],
  async generate(svc, trx, ctx) {
    const def = definitionSchema.parse((ctx.params as { definition: unknown }).definition);
    const perms = await effectivePermissions(trx, ctx.organizationId, ctx.userId);
    const rows = await runReport(trx, def, { orgId: ctx.organizationId, perms });
    return { rows, filename: `report-${def.dataset}` };
  },
});

async function effectivePermissions(trx: Trx, orgId: string, userId: string | null): Promise<Set<string>> {
  if (!userId) return new Set();
  const m = await trx('organization_memberships').where({ organization_id: orgId, user_id: userId, status: 'active' }).first();
  if (!m) return new Set();
  const rows = await trx.raw<{ rows: { permission_key: string }[] }>(
    `SELECT rp.permission_key FROM user_role_assignments ura JOIN role_permissions rp ON rp.role_id = ura.role_id
      WHERE ura.membership_id = ? AND ura.scope_type = 'organization'
     UNION SELECT rp.permission_key FROM user_group_members g JOIN group_roles gr ON gr.group_id = g.group_id
       JOIN role_permissions rp ON rp.role_id = gr.role_id WHERE g.membership_id = ?`, [m.id, m.id]);
  return new Set(rows.rows.map((r) => r.permission_key));
}

defineRoute({
  method: 'post', path: '/reports/export', module: M, moduleFlag: FLAG, summary: 'Export an ad-hoc report (async, streamed to private storage)',
  access: { permission: 'reports:export' }, idempotent: true, entitlement: { key: 'advanced_reports' },
  body: z.object({ definition: definitionSchema, format: z.enum(['csv', 'xlsx', 'json']).default('csv') }), response: obj,
  audit: { action: 'report.exported', resourceType: 'report' },
  async handler(c) {
    compileReport(c.trx, c.body.definition, { orgId: c.orgId(), perms: c.auth!.permissions });
    return { status: 202, data: await requestExport(c, 'adhoc_report', c.body.format, { definition: c.body.definition }) };
  },
});

const nextRun = (from: Date, freq: string) => {
  const d = new Date(from);
  if (freq === 'daily') d.setUTCDate(d.getUTCDate() + 1);
  else if (freq === 'weekly') d.setUTCDate(d.getUTCDate() + 7);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return d;
};

defineRoute({
  method: 'post', path: '/report-schedules', module: M, moduleFlag: FLAG, summary: 'Schedule a saved report (recipients must be members)',
  access: { permission: 'reports:export' },
  body: z.object({ savedReportId: uuid, frequency: z.enum(['daily', 'weekly', 'monthly']), format: z.enum(['csv', 'xlsx']).default('csv'), recipientIds: z.array(uuid).min(1).max(20) }),
  response: obj, audit: { action: 'report_schedule.created', resourceType: 'report_schedule' },
  async handler(c) {
    const sr = await c.trx('saved_reports').where({ id: c.body.savedReportId, organization_id: c.orgId() })
      .where((w) => w.where('owner_id', c.auth!.userId).orWhere('shared', true)).first();
    if (!sr) throw new AppError('NOT_FOUND', 'Saved report not found');
    const members = await c.trx('organization_memberships').where({ organization_id: c.orgId(), status: 'active' }).whereIn('user_id', c.body.recipientIds).select('user_id');
    if (members.length !== new Set(c.body.recipientIds).size) throw new AppError('VALIDATION_FAILED', 'Recipients must be active members of the organization', [{ field: 'recipientIds', issue: 'not_member' }]);
    const id = newId();
    await c.trx('report_schedules').insert({
      id, organization_id: c.orgId(), saved_report_id: sr.id, frequency: c.body.frequency, format: c.body.format, recipient_ids: c.body.recipientIds,
      next_run_at: nextRun(c.svc.now(), c.body.frequency), created_by: c.auth!.userId, updated_by: c.auth!.userId,
    });
    return { status: 201, data: { id, nextRunAt: nextRun(c.svc.now(), c.body.frequency).toISOString() } };
  },
});

defineRoute({
  method: 'get', path: '/report-schedules', module: M, moduleFlag: FLAG, summary: 'List schedules', access: { permission: 'reports:read' }, response: obj,
  async handler(c) {
    return { data: (await c.trx('report_schedules').where({ organization_id: c.orgId(), active: true }).orderBy('next_run_at')).map((r) => rowToApi(r)) };
  },
});

defineRoute({
  method: 'delete', path: '/report-schedules/:id', module: M, moduleFlag: FLAG, summary: 'Cancel a schedule',
  access: { permission: 'reports:export' }, params: z.object({ id: uuid }),
  async handler(c) {
    const n = await c.trx('report_schedules').where({ id: c.params.id, organization_id: c.orgId() }).update({ active: false });
    if (!n) throw new AppError('NOT_FOUND', 'Schedule not found');
    return { status: 204 };
  },
});

/** Runs due schedules; each run stores a private file and emails recipients a pointer (not the data). */
export async function runDueSchedules(svc: Services): Promise<number> {
  const due = await withPlatformScope(svc.db, 'report-schedules', (t) => t('report_schedules').where({ active: true }).where('next_run_at', '<=', svc.now()));
  let ran = 0;
  for (const s of due) {
    try {
      await withTenant(svc.db, { organizationId: s.organization_id, userId: s.created_by }, async (trx) => {
        const claimed = await trx('report_schedules').where({ id: s.id, next_run_at: s.next_run_at }).update({ next_run_at: nextRun(svc.now(), s.frequency), last_run_at: svc.now() });
        if (!claimed) return; // another worker took it
        const sr = await trx('saved_reports').where({ id: s.saved_report_id }).first();
        if (!sr) return;
        const perms = await effectivePermissions(trx, s.organization_id, sr.owner_id);
        const rows = await runReport(trx, definitionSchema.parse(sr.definition), { orgId: s.organization_id, perms });
        const { body, ext } = await renderExport(rows, s.format);
        const file = await saveFile(svc, trx, { organizationId: s.organization_id, ownerId: sr.owner_id, filename: `${sr.name.replace(/[^\w-]+/g, '_')}${ext}`, data: body, purpose: 'report' });
        const users = await svc.db('users').whereIn('id', s.recipient_ids).select('email');
        for (const u of users) {
          await svc.mail.send({ to: u.email, subject: `Scheduled report: ${sr.name}`, text: `Your scheduled report is ready in the organization's files (file ${file.id}).` });
        }
        ran++;
      });
    } catch (e) {
      svc.log.error({ scheduleId: s.id, err: (e as Error).message }, 'scheduled report failed');
    }
  }
  return ran;
}
jobRegistrars.push((svc) => { svc.jobs.work('reports', async () => { await runDueSchedules(svc); }); });
