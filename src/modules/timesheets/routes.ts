import { z } from 'zod';
import { defineRoute, type HandlerCtx } from '../../platform/http/route.js';
import { AppError } from '../../platform/errors.js';
import { newId } from '../../platform/crypto.js';
import { rowToApi, mapDbError, inputToDb } from '../../platform/crud.js';
import { paginate, listQuerySchema, type ListQuery } from '../../platform/pagination.js';
import { isFlagEnabled } from '../../platform/flags.js';
import { jobRegistrars } from '../../platform/job-handlers.js';
import { withTenant, type Trx } from '../../platform/scope.js';
import { createApproval } from '../approvals/routes.js';
import { registerExportKind, requestExport } from '../data/exports.js';
import { registerWidget } from '../dashboard/registry.js';

const M = 'timesheets';
const FLAG = 'module.timesheets';
const obj = z.record(z.string(), z.unknown());
const uuid = z.string().uuid();
const idParams = z.object({ id: uuid });
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export function weekStart(d: string): string {
  const dt = new Date(`${d}T00:00:00Z`);
  const dow = (dt.getUTCDay() + 6) % 7; // Monday = 0
  dt.setUTCDate(dt.getUTCDate() - dow);
  return dt.toISOString().slice(0, 10);
}
const addDays = (d: string, n: number) => {
  const dt = new Date(`${d}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
};
const iso = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v));

async function settings(trx: Trx, orgId: string) {
  const rows = await trx('organization_settings').where({ organization_id: orgId }).whereIn('key', ['timesheets.max_hours_per_day', 'timesheets.work_week', 'timesheets.work_hours_per_day']);
  const m = new Map(rows.map((r) => [r.key as string, r.value]));
  return {
    maxHoursPerDay: Number(m.get('timesheets.max_hours_per_day') ?? 12),
    workWeek: (m.get('timesheets.work_week') as number[] | undefined) ?? [1, 2, 3, 4, 5],
    hoursPerDay: Number(m.get('timesheets.work_hours_per_day') ?? 8),
  };
}

/** Managers see only the members of teams they lead (or everyone with timesheets:manage_all). */
async function reviewableUserIds(c: HandlerCtx): Promise<string[] | 'all'> {
  if (c.auth!.permissions.has('timesheets:manage_all')) return 'all';
  if (!c.auth!.permissions.has('timesheets:review')) return [];
  const rows = await c.trx('team_members as mine').join('team_members as tm', 'tm.team_id', 'mine.team_id')
    .where({ 'mine.user_id': c.auth!.userId, 'mine.is_leader': true, 'mine.organization_id': c.orgId() }).distinct('tm.user_id');
  return rows.map((r) => r.user_id as string);
}

async function loadSheet(c: HandlerCtx, id: string, mode: 'own' | 'view' | 'review') {
  const s = await c.trx('timesheets').where({ id, organization_id: c.orgId() }).first();
  if (!s) throw new AppError('NOT_FOUND', 'Timesheet not found');
  if (s.user_id === c.auth!.userId && mode !== 'review') return s;
  if (mode === 'own') throw new AppError('NOT_FOUND', 'Timesheet not found');
  const scope = await reviewableUserIds(c);
  if (scope !== 'all' && !scope.includes(s.user_id)) throw new AppError('NOT_FOUND', 'Timesheet not found');
  return s;
}

async function totals(trx: Trx, sheetId: string) {
  const r = await trx('time_entries').where({ timesheet_id: sheetId }).select(trx.raw('coalesce(sum(minutes),0)::int AS total'), trx.raw('coalesce(sum(minutes) FILTER (WHERE billable),0)::int AS billable'));
  return { totalMinutes: Number(r[0].total), billableMinutes: Number(r[0].billable) };
}

async function sheetDto(c: HandlerCtx, s: Record<string, unknown>) {
  const entries = await c.trx('time_entries').where({ timesheet_id: s.id }).orderBy(['work_date', 'created_at']);
  return { ...rowToApi(s), ...(await totals(c.trx, s.id as string)), entries: entries.map((e) => rowToApi(e)) };
}

defineRoute({
  method: 'get', path: '/timesheets/mine', module: M, moduleFlag: FLAG, summary: 'My timesheet for a week (created on first access)',
  access: { permission: 'timesheets:read' }, query: z.object({ weekStart: date.optional() }), response: obj,
  async handler(c) {
    const start = weekStart(c.query.weekStart ?? c.svc.now().toISOString().slice(0, 10));
    await c.trx('timesheets').insert({
      id: newId(), organization_id: c.orgId(), user_id: c.auth!.userId, period_start: start, period_end: addDays(start, 6),
      created_by: c.auth!.userId, updated_by: c.auth!.userId,
    }).onConflict(['organization_id', 'user_id', 'period_start']).ignore();
    const s = await c.trx('timesheets').where({ organization_id: c.orgId(), user_id: c.auth!.userId, period_start: start }).first();
    return { data: await sheetDto(c, s) };
  },
});

defineRoute({
  method: 'get', path: '/timesheets/team', module: M, moduleFlag: FLAG, summary: 'Timesheets of the teams I lead',
  access: { permission: 'timesheets:review' }, query: listQuerySchema.extend({ status: z.enum(['draft', 'submitted', 'approved', 'rejected']).optional() }), response: obj,
  async handler(c) {
    const scope = await reviewableUserIds(c);
    const qb = c.trx('timesheets as t').join('users as u', 'u.id', 't.user_id').where('t.organization_id', c.orgId()).select('t.*', 'u.name as user_name');
    if (scope !== 'all') qb.whereIn('t.user_id', scope.length ? scope : [newId()]);
    const q = c.query as { status?: string } & ListQuery;
    if (q.status) qb.where('t.status', q.status);
    const page = await paginate(qb, q, { sortable: { period_start: 't.period_start', created_at: 't.created_at' }, defaultSort: '-period_start', idColumn: 't.id' });
    return { data: page.data.map((r) => rowToApi(r)), meta: page.meta };
  },
});

defineRoute({
  method: 'get', path: '/timesheets/:id', module: M, moduleFlag: FLAG, summary: 'Timesheet with entries (owner or reviewer)',
  access: { permission: 'timesheets:read' }, params: idParams, response: obj,
  async handler(c) { return { data: await sheetDto(c, await loadSheet(c, c.params.id, 'view')) }; },
});

const entryBody = z.object({
  projectId: uuid.nullable().optional(), taskId: uuid.nullable().optional(), workDate: date,
  minutes: z.number().int().min(1).max(1440), billable: z.boolean().default(false), description: z.string().max(500).default(''),
});

async function validateEntry(c: HandlerCtx, sheet: Record<string, unknown>, e: z.infer<typeof entryBody>, excludeId?: string) {
  const ws = iso(sheet.period_start);
  const we = iso(sheet.period_end);
  if (e.workDate < ws || e.workDate > we) throw new AppError('VALIDATION_FAILED', 'Date is outside the timesheet period', [{ field: 'workDate', issue: 'outside_period' }]);
  const st = await settings(c.trx, c.orgId());
  const dow = new Date(`${e.workDate}T00:00:00Z`).getUTCDay();
  if (!st.workWeek.includes(dow)) throw new AppError('VALIDATION_FAILED', 'Date is not a working day', [{ field: 'workDate', issue: 'non_working_day' }]);
  const q = c.trx('time_entries').where({ timesheet_id: sheet.id, work_date: e.workDate });
  if (excludeId) q.whereNot('id', excludeId);
  const used = Number(((await q.sum({ m: 'minutes' }).first()) as { m: string | null }).m ?? 0);
  if (used + e.minutes > st.maxHoursPerDay * 60) {
    throw new AppError('VALIDATION_FAILED', `Daily limit of ${st.maxHoursPerDay} hours exceeded`, [{ field: 'minutes', issue: 'daily_limit_exceeded' }]);
  }
  if (e.projectId) {
    const p = await c.trx('projects').where({ id: e.projectId, organization_id: c.orgId() }).whereNull('deleted_at').first();
    if (!p) throw new AppError('VALIDATION_FAILED', 'Project not found', [{ field: 'projectId', issue: 'not_found' }]);
  }
  if (e.taskId) {
    const t = await c.trx('tasks').where({ id: e.taskId, organization_id: c.orgId() }).whereNull('deleted_at').first();
    if (!t || (e.projectId && t.project_id !== e.projectId)) throw new AppError('VALIDATION_FAILED', 'Task not found in the project', [{ field: 'taskId', issue: 'not_found' }]);
  }
}

const editable = (s: { status: string }) => {
  if (s.status === 'submitted') throw new AppError('CONFLICT', 'A submitted timesheet cannot be edited; recall it first');
  if (s.status === 'approved') throw new AppError('CONFLICT', 'An approved timesheet is immutable; use the correction flow');
};

defineRoute({
  method: 'post', path: '/timesheets/:id/entries', module: M, moduleFlag: FLAG, summary: 'Add a time entry',
  access: { permission: 'timesheets:create' }, params: idParams, body: entryBody, response: obj,
  audit: { action: 'timesheet.entry_added', resourceType: 'timesheet' },
  async handler(c) {
    const s = await loadSheet(c, c.params.id, 'own');
    editable(s);
    await validateEntry(c, s, c.body);
    const id = newId();
    try {
      await c.trx('time_entries').insert({
        id, organization_id: c.orgId(), timesheet_id: s.id, user_id: s.user_id, project_id: c.body.projectId ?? null, task_id: c.body.taskId ?? null,
        work_date: c.body.workDate, minutes: c.body.minutes, billable: c.body.billable, description: c.body.description,
        created_by: c.auth!.userId, updated_by: c.auth!.userId,
      });
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new AppError('CONFLICT', 'An identical entry already exists');
      throw mapDbError(e);
    }
    return { status: 201, data: { id, ...c.body }, auditResourceId: s.id };
  },
});

defineRoute({
  method: 'patch', path: '/timesheets/entries/:id', module: M, moduleFlag: FLAG, summary: 'Update a time entry',
  access: { permission: 'timesheets:update' }, params: idParams, body: entryBody.partial(), response: obj,
  audit: { action: 'timesheet.entry_updated', resourceType: 'timesheet' },
  async handler(c) {
    const e = await c.trx('time_entries').where({ id: c.params.id, organization_id: c.orgId() }).first();
    if (!e) throw new AppError('NOT_FOUND', 'Entry not found');
    const s = await loadSheet(c, e.timesheet_id, 'own');
    editable(s);
    if (Object.keys(c.body).length === 0) throw new AppError('VALIDATION_FAILED', 'No fields to update');
    const merged = {
      projectId: c.body.projectId === undefined ? e.project_id : c.body.projectId, taskId: c.body.taskId === undefined ? e.task_id : c.body.taskId,
      workDate: c.body.workDate ?? iso(e.work_date), minutes: c.body.minutes ?? e.minutes, billable: c.body.billable ?? e.billable,
      description: c.body.description ?? e.description,
    };
    await validateEntry(c, s, merged, e.id);
    try {
      await c.trx('time_entries').where({ id: e.id }).update({ ...inputToDb(c.body), updated_at: c.svc.now(), updated_by: c.auth!.userId });
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new AppError('CONFLICT', 'An identical entry already exists');
      throw mapDbError(err);
    }
    return { status: 200, data: rowToApi(await c.trx('time_entries').where({ id: e.id }).first()), auditResourceId: s.id };
  },
});

defineRoute({
  method: 'delete', path: '/timesheets/entries/:id', module: M, moduleFlag: FLAG, summary: 'Delete a time entry',
  access: { permission: 'timesheets:update' }, params: idParams, audit: { action: 'timesheet.entry_deleted', resourceType: 'timesheet' },
  async handler(c) {
    const e = await c.trx('time_entries').where({ id: c.params.id, organization_id: c.orgId() }).first();
    if (!e) throw new AppError('NOT_FOUND', 'Entry not found');
    const s = await loadSheet(c, e.timesheet_id, 'own');
    editable(s);
    await c.trx('time_entries').where({ id: e.id }).delete();
    return { status: 204, auditResourceId: s.id };
  },
});

defineRoute({
  method: 'post', path: '/timesheets/:id/submit', module: M, moduleFlag: FLAG, summary: 'Submit for approval',
  access: { permission: 'timesheets:create' }, params: idParams, idempotent: true, response: obj,
  audit: { action: 'timesheet.submitted', resourceType: 'timesheet' },
  async handler(c) {
    const s = await loadSheet(c, c.params.id, 'own');
    if (!['draft', 'rejected'].includes(s.status)) throw new AppError('CONFLICT', `A ${s.status} timesheet cannot be submitted`);
    const t = await totals(c.trx, s.id);
    if (t.totalMinutes === 0) throw new AppError('VALIDATION_FAILED', 'Add at least one time entry before submitting', [{ field: 'entries', issue: 'empty' }]);
    let approvalId: string | null = null;
    if (await isFlagEnabled(c.trx, 'module.approvals', { organizationId: c.orgId() })) {
      const tpl = await c.trx('approval_templates').where({ organization_id: c.orgId(), subject_type: 'timesheet', active: true }).first();
      if (tpl) {
        approvalId = (await createApproval(c.trx, c.svc, c.orgId(), c.auth!.userId, {
          templateId: tpl.id, subjectType: 'timesheet', subjectId: s.id, title: `Timesheet ${iso(s.period_start)} (rev ${s.revision})`,
          steps: tpl.steps, payload: { totalMinutes: t.totalMinutes }, preventSelfApproval: tpl.prevent_self_approval,
        })).id;
      }
    }
    await c.trx('timesheets').where({ id: s.id }).update({
      status: 'submitted', submitted_at: c.svc.now(), approval_request_id: approvalId, decision_note: null, updated_at: c.svc.now(), updated_by: c.auth!.userId,
      row_version: c.trx.raw('row_version + 1'),
    });
    await c.emit('timesheet.submitted', { timesheetId: s.id, userId: s.user_id, periodStart: iso(s.period_start) });
    return { status: 200, data: { id: s.id, status: 'submitted', approvalRequestId: approvalId } };
  },
});

defineRoute({
  method: 'post', path: '/timesheets/:id/recall', module: M, moduleFlag: FLAG, summary: 'Recall a submitted timesheet',
  access: { permission: 'timesheets:update' }, params: idParams, response: obj, audit: { action: 'timesheet.recalled', resourceType: 'timesheet' },
  async handler(c) {
    const s = await loadSheet(c, c.params.id, 'own');
    if (s.status !== 'submitted') throw new AppError('CONFLICT', 'Only submitted timesheets can be recalled');
    if (s.approval_request_id) {
      const a = await c.trx('approval_requests').where({ id: s.approval_request_id }).first();
      if (a && a.status === 'pending') {
        await c.trx('approval_requests').where({ id: a.id }).update({ status: 'cancelled', completed_at: c.svc.now() });
      }
    }
    await c.trx('timesheets').where({ id: s.id }).update({ status: 'draft', submitted_at: null, approval_request_id: null, updated_at: c.svc.now(), row_version: c.trx.raw('row_version + 1') });
    return { status: 200, data: { id: s.id, status: 'draft' } };
  },
});

async function decideSheet(c: HandlerCtx<{ id: string }>, status: 'approved' | 'rejected', note?: string) {
  const s = await loadSheet(c as unknown as HandlerCtx, c.params.id, 'review');
  if (s.user_id === c.auth!.userId) throw new AppError('FORBIDDEN', 'You cannot approve your own timesheet');
  if (s.status !== 'submitted') throw new AppError('CONFLICT', `A ${s.status} timesheet cannot be ${status}`);
  if (s.approval_request_id) throw new AppError('CONFLICT', 'This timesheet is decided through its approval request');
  await c.trx('timesheets').where({ id: s.id }).update({
    status, decided_at: c.svc.now(), decided_by: c.auth!.userId, decision_note: note ?? null, updated_at: c.svc.now(), row_version: c.trx.raw('row_version + 1'),
  });
  await c.emit(`timesheet.${status}`, { timesheetId: s.id, userId: s.user_id, periodStart: iso(s.period_start) });
  return { status: 200, data: { id: s.id, status }, auditResourceId: s.id };
}

for (const [verb, status] of [['approve', 'approved'], ['reject', 'rejected']] as const) {
  defineRoute({
    method: 'post', path: `/timesheets/:id/${verb}`, module: M, moduleFlag: FLAG, summary: `${verb} a timesheet`,
    access: { permission: 'timesheets:approve' }, params: idParams, idempotent: true,
    body: z.object({ note: z.string().max(1000).optional() }).default({}), response: obj,
    audit: { action: `timesheet.${status}`, resourceType: 'timesheet' },
    handler: (c) => decideSheet(c, status, (c.body as { note?: string }).note),
  });
}

defineRoute({
  method: 'post', path: '/timesheets/:id/corrections', module: M, moduleFlag: FLAG, summary: 'Reopen an approved timesheet as a new revision',
  access: { permission: 'timesheets:update' }, params: idParams, body: z.object({ reason: z.string().trim().min(5).max(500) }), response: obj,
  audit: { action: 'timesheet.correction_started', resourceType: 'timesheet' },
  async handler(c) {
    const s = await loadSheet(c, c.params.id, 'view');
    if (s.status !== 'approved') throw new AppError('CONFLICT', 'Only approved timesheets need a correction');
    const billed = await c.trx('time_entries').where({ timesheet_id: s.id }).whereNotNull('invoice_id').first();
    if (billed) throw new AppError('CONFLICT', 'Entries already invoiced; issue a credit note instead');
    await c.trx('timesheet_corrections').insert({
      id: newId(), organization_id: c.orgId(), timesheet_id: s.id, revision_from: s.revision, revision_to: s.revision + 1, reason: c.body.reason, actor_id: c.auth!.userId,
    });
    await c.trx('timesheets').where({ id: s.id }).update({
      status: 'draft', revision: s.revision + 1, decided_at: null, decided_by: null, approval_request_id: null,
      updated_at: c.svc.now(), row_version: c.trx.raw('row_version + 1'),
    });
    return { status: 201, data: { id: s.id, status: 'draft', revision: s.revision + 1 } };
  },
});

defineRoute({
  method: 'get', path: '/timesheets/:id/corrections', module: M, moduleFlag: FLAG, summary: 'Correction audit trail',
  access: { permission: 'timesheets:read' }, params: idParams, response: obj,
  async handler(c) {
    const s = await loadSheet(c, c.params.id, 'view');
    return { data: (await c.trx('timesheet_corrections').where({ timesheet_id: s.id }).orderBy('occurred_at')).map((r) => rowToApi(r)) };
  },
});

const range = z.object({ from: date, to: date, projectId: uuid.optional() });

defineRoute({
  method: 'get', path: '/timesheets/reports/utilization', module: M, moduleFlag: FLAG, summary: 'Utilization by person for approved time',
  access: { permission: 'timesheets:read' }, query: range, response: obj,
  async handler(c) {
    if (c.query.from > c.query.to) throw new AppError('VALIDATION_FAILED', 'from must not be after to', [{ field: 'from', issue: 'after to' }]);
    const scope = await reviewableUserIds(c);
    const st = await settings(c.trx, c.orgId());
    const qb = c.trx('time_entries as e').join('timesheets as t', 't.id', 'e.timesheet_id').join('users as u', 'u.id', 'e.user_id')
      .where({ 'e.organization_id': c.orgId(), 't.status': 'approved' }).whereBetween('e.work_date', [c.query.from, c.query.to]);
    if (scope !== 'all') qb.whereIn('e.user_id', [...scope, c.auth!.userId]);
    if (c.query.projectId) qb.where('e.project_id', c.query.projectId);
    const rows = (await qb.groupBy('e.user_id', 'u.name').select('e.user_id', 'u.name').sum({ total: 'e.minutes' })
      .select(c.trx.raw('coalesce(sum(e.minutes) FILTER (WHERE e.billable),0)::int AS billable'))) as unknown as { user_id: string; name: string; total: string; billable: number }[];
    let workDays = 0;
    for (let d = c.query.from; d <= c.query.to; d = addDays(d, 1)) if (st.workWeek.includes(new Date(`${d}T00:00:00Z`).getUTCDay())) workDays++;
    const capacity = workDays * st.hoursPerDay * 60;
    return {
      data: rows.map((r) => ({
        userId: r.user_id, name: r.name, totalMinutes: Number(r.total), billableMinutes: Number(r.billable),
        nonBillableMinutes: Number(r.total) - Number(r.billable), capacityMinutes: capacity,
        utilizationPct: capacity ? Math.round((Number(r.total) / capacity) * 1000) / 10 : 0,
      })),
    };
  },
});

defineRoute({
  method: 'get', path: '/timesheets/reports/billable', module: M, moduleFlag: FLAG, summary: 'Billable vs non-billable per project',
  access: { permission: 'timesheets:review' }, query: range, response: obj,
  async handler(c) {
    const rows = (await c.trx('time_entries as e').join('timesheets as t', 't.id', 'e.timesheet_id').leftJoin('projects as p', 'p.id', 'e.project_id')
      .where({ 'e.organization_id': c.orgId(), 't.status': 'approved' }).whereBetween('e.work_date', [c.query.from, c.query.to])
      .groupBy('e.project_id', 'p.name').select('e.project_id', 'p.name')
      .select(c.trx.raw('coalesce(sum(e.minutes) FILTER (WHERE e.billable),0)::int AS billable'))
      .select(c.trx.raw('coalesce(sum(e.minutes) FILTER (WHERE NOT e.billable),0)::int AS non_billable'))) as unknown as { project_id: string | null; name: string | null; billable: number; non_billable: number }[];
    return { data: rows.map((r) => ({ projectId: r.project_id, project: r.name, billableMinutes: Number(r.billable), nonBillableMinutes: Number(r.non_billable) })) };
  },
});

registerExportKind('timesheets', {
  permission: 'timesheets:review', formats: ['csv', 'xlsx', 'json'],
  async generate(_svc, trx, ctx) {
    const p = ctx.params as { from?: string; to?: string };
    const q = trx('time_entries as e').join('timesheets as t', 't.id', 'e.timesheet_id').join('users as u', 'u.id', 'e.user_id')
      .leftJoin('projects as pr', 'pr.id', 'e.project_id')
      .where('e.organization_id', ctx.organizationId).orderBy(['e.work_date', 'u.name'])
      .select('u.name as person', 'pr.name as project', 'e.work_date', 'e.minutes', 'e.billable', 'e.description', 't.status', 't.revision');
    if (p.from) q.where('e.work_date', '>=', p.from);
    if (p.to) q.where('e.work_date', '<=', p.to);
    return { rows: await q, filename: 'timesheets' };
  },
});

defineRoute({
  method: 'post', path: '/timesheets/export', module: M, moduleFlag: FLAG, summary: 'Export timesheet entries (async)',
  access: { permission: 'timesheets:review' }, idempotent: true,
  body: z.object({ format: z.enum(['csv', 'xlsx', 'json']).default('csv'), from: date.optional(), to: date.optional() }), response: obj,
  audit: { action: 'timesheet.exported', resourceType: 'timesheet' },
  async handler(c) {
    const { format, ...params } = c.body;
    return { status: 202, data: await requestExport(c, 'timesheets', format, params) };
  },
});

// Approval engine decisions flow back to the timesheet.
jobRegistrars.push((svc) => {
  for (const status of ['approved', 'rejected', 'changes_requested'] as const) {
    svc.events.on(`approval.${status}`, async (e) => {
      if (e.payload.subjectType !== 'timesheet' || !e.organizationId) return;
      await withTenant(svc.db, { organizationId: e.organizationId, userId: null }, async (trx) => {
        const next = status === 'approved' ? 'approved' : 'rejected';
        const n = await trx('timesheets').where({ id: e.payload.subjectId as string, status: 'submitted' }).update({
          status: next, decided_at: svc.now(), decided_by: (e.payload.decidedBy as string) ?? null, updated_at: svc.now(),
          row_version: trx.raw('row_version + 1'),
        });
        if (n) await svc.events.emit(trx, `timesheet.${next}`, e.organizationId, { timesheetId: e.payload.subjectId, userId: e.payload.requesterId });
      });
    });
  }
});

registerWidget({
  key: 'timesheets.summary', title: 'Timesheets', requiredPermission: 'timesheets:read', requiredModuleFlag: FLAG,
  async query({ trx, organizationId, userId }) {
    const mine = (await trx('timesheets').where({ organization_id: organizationId, user_id: userId }).select('status').count({ c: '*' }).groupBy('status')) as unknown as { status: string; c: string }[];
    return { mine: Object.fromEntries(mine.map((r) => [r.status, Number(r.c)])) };
  },
});
