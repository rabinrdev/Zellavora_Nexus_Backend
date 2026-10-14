import { stringify } from 'csv-stringify/sync';
import ExcelJS from 'exceljs';
import { z } from 'zod';
import { defineRoute, type HandlerCtx } from '../../platform/http/route.js';
import { AppError } from '../../platform/errors.js';
import { newId } from '../../platform/crypto.js';
import { saveFile, signDownload, assertDownloadable } from '../../platform/files.js';
import { jobRegistrars } from '../../platform/job-handlers.js';
import { withPlatformScope, withTenant, type Trx } from '../../platform/scope.js';
import { paginate, listQuerySchema, type ListQuery } from '../../platform/pagination.js';
import { rowToApi } from '../../platform/crud.js';
import type { Services } from '../../platform/types.js';

export type ExportFormat = 'csv' | 'xlsx' | 'json';
export interface ExportResult { rows: Record<string, unknown>[]; filename: string }
export interface ExportKind {
  permission: string;
  formats: ExportFormat[];
  generate(svc: Services, trx: Trx, ctx: { organizationId: string; userId: string | null; params: Record<string, unknown> }): Promise<ExportResult>;
}

const kinds = new Map<string, ExportKind>();
export const registerExportKind = (kind: string, def: ExportKind) => void kinds.set(kind, def);
export const exportKinds = () => [...kinds.keys()];

const isoRow = (r: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v !== null && typeof v === 'object' ? JSON.stringify(v) : v]));

export async function renderExport(rows: Record<string, unknown>[], format: ExportFormat): Promise<{ body: Buffer; ext: string }> {
  const flat = rows.map(isoRow);
  if (format === 'json') return { body: Buffer.from(JSON.stringify(rows, null, 2), 'utf8'), ext: '.json' };
  const columns = flat.length ? Object.keys(flat[0]!) : [];
  if (format === 'csv') {
    // neutralize spreadsheet formula injection in text cells
    const safe = flat.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v])));
    return { body: Buffer.from(stringify(safe, { header: true, columns }), 'utf8'), ext: '.csv' };
  }
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Export');
  ws.columns = columns.map((c) => ({ header: c, key: c }));
  for (const r of flat) ws.addRow(r);
  return { body: Buffer.from(await wb.xlsx.writeBuffer()), ext: '.xlsx' };
}

/** Creates the job row in the caller's transaction; the worker runs after commit via the outbox. */
export async function requestExport(c: HandlerCtx, kind: string, format: ExportFormat, params: Record<string, unknown> = {}) {
  const def = kinds.get(kind);
  if (!def) throw new AppError('VALIDATION_FAILED', 'Unknown export kind', [{ field: 'kind', issue: 'unknown' }]);
  if (!def.formats.includes(format)) throw new AppError('VALIDATION_FAILED', 'Unsupported format', [{ field: 'format', issue: 'unsupported' }]);
  if (!c.auth!.permissions.has(def.permission)) throw new AppError('FORBIDDEN', 'You do not have permission to perform this action');
  const id = newId();
  await c.trx('export_jobs').insert({
    id, organization_id: c.orgId(), kind, format, params: JSON.stringify(params), requested_by: c.auth!.userId,
  });
  await c.emit('export.requested', { exportId: id });
  return { id, kind, format, status: 'pending' };
}

jobRegistrars.push((svc) => {
  svc.events.on('export.requested', async (e) => {
    await svc.jobs.enqueue('exports', { exportId: e.payload.exportId as string, organizationId: e.organizationId });
  });
  svc.jobs.work('exports', async (data) => {
    const exportId = data.exportId as string;
    const orgId = data.organizationId as string;
    const job = await withPlatformScope(svc.db, 'export-load', (t) => t('export_jobs').where({ id: exportId }).first());
    if (!job || job.status === 'completed') return;
    try {
      await withTenant(svc.db, { organizationId: orgId, userId: job.requested_by }, async (trx) => {
        await trx('export_jobs').where({ id: exportId }).update({ status: 'processing' });
        const def = kinds.get(job.kind);
        if (!def) throw new Error('unknown kind');
        const result = await def.generate(svc, trx, { organizationId: orgId, userId: job.requested_by, params: job.params });
        const { body, ext } = await renderExport(result.rows, job.format);
        const file = await saveFile(svc, trx, {
          organizationId: orgId, ownerId: job.requested_by, filename: `${result.filename}${ext}`, data: body, purpose: 'export',
          maxBytes: 200 * 1024 * 1024,
        });
        await trx('export_jobs').where({ id: exportId }).update({
          status: 'completed', file_id: file.id, finished_at: svc.now(), expires_at: new Date(svc.now().getTime() + 24 * 3600_000),
        });
      });
    } catch (err) {
      await withPlatformScope(svc.db, 'export-fail', (t) =>
        t('export_jobs').where({ id: exportId }).update({ status: 'failed', finished_at: svc.now() }));
      throw err;
    }
  });
});

// ---- generic export routes ---------------------------------------------------------------------------------

const M = 'exports';
const obj = z.record(z.string(), z.unknown());

defineRoute({
  method: 'post', path: '/exports', module: M, summary: 'Request an asynchronous export',
  access: { permission: 'exports:create' }, idempotent: true,
  body: z.object({ kind: z.string().max(60), format: z.enum(['csv', 'xlsx', 'json']).default('csv'), params: z.record(z.string(), z.unknown()).default({}) }),
  response: obj, audit: { action: 'export.requested', resourceType: 'export' },
  async handler(c) {
    return { status: 202, data: await requestExport(c, c.body.kind, c.body.format, c.body.params) };
  },
});

defineRoute({
  method: 'get', path: '/exports', module: M, summary: 'List my organization exports', access: { permission: 'exports:read' },
  query: listQuerySchema, response: obj,
  async handler(c) {
    const page = await paginate(c.trx('export_jobs').where({ organization_id: c.orgId() }), c.query as ListQuery, {
      sortable: { created_at: 'created_at' }, filterable: { status: 'status', kind: 'kind' }, defaultSort: '-created_at',
    });
    return { data: page.data.map((r) => rowToApi(r)), meta: page.meta };
  },
});

defineRoute({
  method: 'get', path: '/exports/:id', module: M, summary: 'Export status and expiring download link',
  access: { permission: 'exports:read' }, params: z.object({ id: z.string().uuid() }), response: obj,
  async handler(c) {
    const j = await c.trx('export_jobs').where({ id: c.params.id, organization_id: c.orgId() }).first();
    if (!j) throw new AppError('NOT_FOUND', 'Export not found');
    let link: { url: string; expiresAt: string } | null = null;
    if (j.status === 'completed' && j.file_id && j.expires_at && new Date(j.expires_at) > c.svc.now()) {
      const f = await c.trx('files').where({ id: j.file_id }).first();
      if (f) {
        assertDownloadable(f);
        const s = signDownload(c.svc.env.JWT_SECRET, f.id, c.orgId());
        link = { url: `/api/v1/files/download/${s.token}`, expiresAt: s.expiresAt };
      }
    }
    return { data: { ...rowToApi(j), downloadLink: link } };
  },
});

// ---- built-in kinds ---------------------------------------------------------------------------------------------

registerExportKind('users', {
  permission: 'users:read', formats: ['csv', 'xlsx', 'json'],
  async generate(_svc, trx, ctx) {
    const rows = await trx('organization_memberships as m').join('users as u', 'u.id', 'm.user_id')
      .where('m.organization_id', ctx.organizationId).select('u.email', 'u.name', 'm.status', 'm.joined_at').orderBy('u.email');
    return { rows, filename: 'users' };
  },
});

registerExportKind('audit', {
  permission: 'audit:export', formats: ['csv', 'json'],
  async generate(_svc, trx, ctx) {
    const p = ctx.params as { from?: string; to?: string; action?: string };
    const q = trx('audit_events').where({ organization_id: ctx.organizationId }).orderBy('occurred_at', 'desc').limit(100000)
      .select('id', 'occurred_at', 'actor_id', 'actor_type', 'action', 'resource_type', 'resource_id', 'outcome', 'correlation_id');
    if (p.from) q.where('occurred_at', '>=', p.from);
    if (p.to) q.where('occurred_at', '<=', p.to);
    if (p.action) q.where('action', p.action);
    return { rows: await q, filename: 'audit-events' };
  },
});

registerExportKind('organization_data', {
  permission: 'organization:export', formats: ['json'],
  async generate(_svc, trx, ctx) {
    const org = await trx('organizations').where({ id: ctx.organizationId }).first('id', 'name', 'code', 'type', 'status', 'timezone', 'locale', 'currency', 'created_at');
    const members = await trx('organization_memberships as m').join('users as u', 'u.id', 'm.user_id')
      .where('m.organization_id', ctx.organizationId).select('u.email', 'u.name', 'm.status', 'm.joined_at');
    const departments = await trx('departments').where({ organization_id: ctx.organizationId }).select('name', 'parent_id', 'created_at');
    const locations = await trx('locations').where({ organization_id: ctx.organizationId }).select('name', 'address', 'timezone');
    const settings = await trx('organization_settings').where({ organization_id: ctx.organizationId }).select('key', 'value');
    return {
      rows: [{ section: 'organization', data: org }, { section: 'members', data: members }, { section: 'departments', data: departments },
        { section: 'locations', data: locations }, { section: 'settings', data: settings }] as unknown as Record<string, unknown>[],
      filename: `organization-export-${ctx.organizationId.slice(0, 8)}`,
    };
  },
});

registerExportKind('security_events', {
  permission: 'audit:export', formats: ['csv', 'json'],
  async generate(_svc, trx, ctx) {
    const rows = await trx('security_events').where({ organization_id: ctx.organizationId }).orderBy('occurred_at', 'desc').limit(100000)
      .select('id', 'occurred_at', 'user_id', 'event', 'outcome', 'ip', 'correlation_id');
    return { rows, filename: 'security-events' };
  },
});

defineRoute({
  method: 'post', path: '/organization/data-export', module: 'organizations', summary: 'Export all organization data (async)',
  access: { permission: 'organization:export' }, allowSuspendedTenant: true, idempotent: true, response: obj,
  audit: { action: 'organization.data_export_requested', resourceType: 'organization' },
  async handler(c) {
    return { status: 202, data: await requestExport(c, 'organization_data', 'json'), auditResourceId: c.orgId() };
  },
});
