import { z } from 'zod';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import { defineRoute } from '../../platform/http/route.js';
import { AppError } from '../../platform/errors.js';
import { newId } from '../../platform/crypto.js';
import { paginate, listQuerySchema, type ListQuery } from '../../platform/pagination.js';
import { rowToApi } from '../../platform/crud.js';
import { jobRegistrars } from '../../platform/job-handlers.js';
import { saveFile } from '../../platform/files.js';
import { withPlatformScope, withTenant, type Trx } from '../../platform/scope.js';
import { recordAudit } from '../../platform/audit.js';
import type { Services } from '../../platform/types.js';

const M = 'data';
const obj = z.record(z.string(), z.unknown());
const idParams = z.object({ id: z.string().uuid() });

// ---- imports (F-148) -------------------------------------------------------------------------------------------

export interface ImportError { row: number; field?: string; issue: string }
export interface ImportResource {
  permission: string;
  columns: string[];
  row: z.ZodType<Record<string, unknown>>;
  apply(trx: Trx, ctx: { organizationId: string; userId: string }, row: Record<string, unknown>): Promise<void>;
}
const resources = new Map<string, ImportResource>();
export const registerImportResource = (name: string, r: ImportResource) => void resources.set(name, r);

const ROLLBACK = Symbol('rollback');
const SYNC_ROW_LIMIT = 200;
const MAX_ROWS = 20000;

/** All-or-nothing: any invalid/duplicate row aborts the batch so nothing is half-applied. `dryRun` never persists. */
export async function runImport(
  trx: Trx, resource: string, ctx: { organizationId: string; userId: string }, rows: Record<string, string>[], dryRun: boolean,
): Promise<{ total: number; applied: number; errors: ImportError[] }> {
  const def = resources.get(resource)!;
  const errors: ImportError[] = [];
  const parsed: { n: number; v: Record<string, unknown> }[] = [];
  rows.forEach((raw, i) => {
    const r = def.row.safeParse(raw);
    if (!r.success) r.error.issues.forEach((is) => errors.push({ row: i + 2, field: is.path.join('.'), issue: is.message }));
    else parsed.push({ n: i + 2, v: r.data });
  });
  let applied = 0;
  if (errors.length === 0) {
    try {
      await trx.transaction(async (sp) => {
        for (const { n, v } of parsed) {
          try {
            await sp.transaction(async (rowTrx) => def.apply(rowTrx, ctx, v));
            applied++;
          } catch (e) {
            const code = (e as { code?: string }).code;
            errors.push({ row: n, issue: e instanceof AppError ? e.message : code === '23505' ? 'duplicate value' : 'could not be applied' });
          }
        }
        if (errors.length > 0 || dryRun) throw ROLLBACK;
      });
    } catch (e) {
      if (e !== ROLLBACK) throw e;
    }
  }
  if (errors.length > 0 || dryRun) applied = errors.length === 0 && dryRun ? applied : 0;
  return { total: rows.length, applied, errors };
}

function parseCsv(buf: Buffer): Record<string, string>[] {
  try {
    return parse(buf, { columns: true, skip_empty_lines: true, trim: true, bom: true, relax_column_count: false }) as Record<string, string>[];
  } catch {
    throw new AppError('VALIDATION_FAILED', 'Malformed CSV', [{ field: 'file', issue: 'could not parse CSV' }]);
  }
}

registerImportResource('departments', {
  permission: 'departments:create', columns: ['name', 'parentName'],
  row: z.object({ name: z.string().min(2).max(120), parentName: z.string().max(120).optional().default('') }).transform((v) => v),
  async apply(trx, ctx, r) {
    let parent: string | null = null;
    if (r.parentName) {
      const p = await trx('departments').whereRaw('lower(name) = lower(?)', [r.parentName as string]).where({ organization_id: ctx.organizationId }).whereNull('deleted_at').first();
      if (!p) throw new AppError('VALIDATION_FAILED', `parent "${r.parentName}" not found`);
      parent = p.id;
    }
    await trx('departments').insert({ id: newId(), organization_id: ctx.organizationId, name: r.name, parent_id: parent, created_by: ctx.userId, updated_by: ctx.userId });
  },
});

registerImportResource('locations', {
  permission: 'locations:create', columns: ['name', 'address', 'timezone'],
  row: z.object({ name: z.string().min(2).max(120), address: z.string().max(500).optional().default(''), timezone: z.string().max(64).optional().default('') }),
  async apply(trx, ctx, r) {
    await trx('locations').insert({
      id: newId(), organization_id: ctx.organizationId, name: r.name, address: r.address || null, timezone: r.timezone || null,
      created_by: ctx.userId, updated_by: ctx.userId,
    });
  },
});

defineRoute({
  method: 'get', path: '/imports/templates/:resource', module: M, summary: 'CSV import template', access: { permission: 'imports:read' },
  params: z.object({ resource: z.string().max(40) }), binary: true,
  async handler(c) {
    const r = resources.get(c.params.resource);
    if (!r) throw new AppError('NOT_FOUND', 'Unknown import resource');
    return { status: 200, raw: { contentType: 'text/csv', body: stringify([r.columns]), filename: `${c.params.resource}-template.csv` } };
  },
});

defineRoute({
  method: 'post', path: '/imports', module: M, summary: 'Import records from CSV (validate, dry-run, all-or-nothing)',
  access: { permission: 'imports:create' }, upload: { field: 'file', maxBytes: 5 * 1024 * 1024 }, idempotent: true,
  body: z.object({ resource: z.string().max(40), dryRun: z.enum(['true', 'false']).default('false').transform((v) => v === 'true') }),
  response: obj, audit: { action: 'import.requested', resourceType: 'import_job' },
  async handler(c) {
    const def = resources.get(c.body.resource);
    if (!def) throw new AppError('VALIDATION_FAILED', 'Unknown import resource', [{ field: 'resource', issue: 'unknown' }]);
    if (!c.auth!.permissions.has(def.permission)) throw new AppError('FORBIDDEN', 'You do not have permission to perform this action');
    if (!c.req.file) throw new AppError('VALIDATION_FAILED', 'A CSV file is required', [{ field: 'file', issue: 'required' }]);
    const rows = parseCsv(c.req.file.buffer);
    if (rows.length === 0) throw new AppError('VALIDATION_FAILED', 'CSV has no rows', [{ field: 'file', issue: 'empty' }]);
    if (rows.length > MAX_ROWS) throw new AppError('VALIDATION_FAILED', `Too many rows (max ${MAX_ROWS})`, [{ field: 'file', issue: 'too_many_rows' }]);
    const missing = def.columns.filter((col) => col !== 'parentName' && !(col in rows[0]!) && ['name'].includes(col));
    if (missing.length) throw new AppError('VALIDATION_FAILED', 'Missing columns', missing.map((m) => ({ field: m, issue: 'missing column' })));
    const id = newId();
    const ctx = { organizationId: c.orgId(), userId: c.auth!.userId };
    if (rows.length <= SYNC_ROW_LIMIT) {
      const res = await runImport(c.trx, c.body.resource, ctx, rows, c.body.dryRun);
      const status = res.errors.length ? 'failed' : c.body.dryRun ? 'dry_run' : 'completed';
      await c.trx('import_jobs').insert({
        id, organization_id: c.orgId(), resource: c.body.resource, status, dry_run: c.body.dryRun, total_rows: res.total,
        success_rows: res.applied, error_rows: res.errors.length, errors: JSON.stringify(res.errors.slice(0, 500)),
        created_by: c.auth!.userId, finished_at: c.svc.now(),
      });
      return { status: 200, data: { id, status, total: res.total, applied: res.applied, errors: res.errors.slice(0, 500) }, auditResourceId: id };
    }
    const file = await saveFile(c.svc, c.trx, {
      organizationId: c.orgId(), ownerId: c.auth!.userId, filename: 'import.csv', data: c.req.file.buffer, purpose: 'import',
    });
    await c.trx('import_jobs').insert({
      id, organization_id: c.orgId(), resource: c.body.resource, status: 'pending', dry_run: c.body.dryRun,
      total_rows: rows.length, file_id: file.id, created_by: c.auth!.userId,
    });
    await c.emit('import.requested', { importId: id });
    return { status: 202, data: { id, status: 'pending', total: rows.length }, auditResourceId: id };
  },
});

jobRegistrars.push((svc: Services) => {
  svc.events.on('import.requested', async (e) => {
    await svc.jobs.enqueue('imports', { importId: e.payload.importId as string, organizationId: e.organizationId });
  });
  svc.jobs.work('imports', async (data) => {
    const orgId = data.organizationId as string;
    const importId = data.importId as string;
    const job = await withPlatformScope(svc.db, 'import-load', (t) => t('import_jobs').where({ id: importId }).first());
    if (!job || job.status !== 'pending') return;
    await withTenant(svc.db, { organizationId: orgId, userId: job.created_by }, async (trx) => {
      const f = await trx('files').where({ id: job.file_id }).first();
      const rows = parseCsv(await svc.storage.get(f.object_key));
      const res = await runImport(trx, job.resource, { organizationId: orgId, userId: job.created_by }, rows, job.dry_run);
      await trx('import_jobs').where({ id: importId }).update({
        status: res.errors.length ? 'failed' : job.dry_run ? 'dry_run' : 'completed', success_rows: res.applied,
        error_rows: res.errors.length, errors: JSON.stringify(res.errors.slice(0, 500)), finished_at: svc.now(), updated_at: svc.now(),
      });
    });
  });
});

defineRoute({
  method: 'get', path: '/imports/:id', module: M, summary: 'Import job result with row-level errors', access: { permission: 'imports:read' },
  params: idParams, response: obj,
  async handler(c) {
    const j = await c.trx('import_jobs').where({ id: c.params.id, organization_id: c.orgId() }).first();
    if (!j) throw new AppError('NOT_FOUND', 'Import not found');
    return { data: rowToApi(j) };
  },
});

// ---- retention (F-149) -----------------------------------------------------------------------------------------

const RETAINABLE: Record<string, { table: string; column: string; soft?: boolean }> = {
  audit_events: { table: 'audit_events', column: 'occurred_at' },
  export_jobs: { table: 'export_jobs', column: 'created_at' },
  departments: { table: 'departments', column: 'deleted_at', soft: true },
  locations: { table: 'locations', column: 'deleted_at', soft: true },
  files: { table: 'files', column: 'deleted_at', soft: true },
};

defineRoute({
  method: 'put', path: '/retention/policies/:resource', module: M, summary: 'Set a retention policy',
  access: { permission: 'retention:manage' }, params: z.object({ resource: z.string().max(40) }),
  body: z.object({ retentionDays: z.number().int().min(1).max(3650), action: z.enum(['archive', 'purge']).default('purge'), legalHold: z.boolean().default(false) }),
  response: obj, audit: { action: 'retention.policy_changed', resourceType: 'retention_policy' },
  async handler(c) {
    if (!RETAINABLE[c.params.resource]) throw new AppError('VALIDATION_FAILED', 'Resource is not retention-managed', [{ field: 'resource', issue: 'unsupported' }]);
    await c.trx('data_retention_policies').insert({
      id: newId(), organization_id: c.orgId(), resource: c.params.resource, retention_days: c.body.retentionDays, action: c.body.action, legal_hold: c.body.legalHold,
    }).onConflict(['organization_id', 'resource']).merge({
      retention_days: c.body.retentionDays, action: c.body.action, legal_hold: c.body.legalHold, updated_at: c.svc.now(),
    });
    return { status: 200, data: { resource: c.params.resource, ...c.body } };
  },
});

defineRoute({
  method: 'get', path: '/retention/policies', module: M, summary: 'List retention policies', access: { permission: 'retention:manage' }, response: obj,
  async handler(c) {
    return { data: (await c.trx('data_retention_policies').where({ organization_id: c.orgId() })).map((r) => rowToApi(r)) };
  },
});

export async function runRetention(svc: Services, organizationId: string, dryRun: boolean): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  await withPlatformScope(svc.db, 'retention-run', async (t) => {
    const policies = await t('data_retention_policies').where({ organization_id: organizationId });
    for (const p of policies) {
      const def = RETAINABLE[p.resource as string];
      if (!def || p.legal_hold) { out[p.resource] = 0; continue; } // legal hold wins
      const cutoff = new Date(svc.now().getTime() - p.retention_days * 86400_000);
      if (p.resource === 'audit_events') {
        if (dryRun) {
          const r = await t('audit_events').where({ organization_id: organizationId }).where('occurred_at', '<', cutoff).count({ c: '*' }).first();
          out[p.resource] = Number((r as { c: string }).c);
        } else {
          const r = await t.raw('SELECT purge_audit_events(?, ?) AS n', [organizationId, cutoff]);
          out[p.resource] = Number(r.rows[0].n);
        }
        continue;
      }
      const q = t(def.table).where({ organization_id: organizationId }).where(def.column, '<', cutoff);
      if (dryRun) out[p.resource] = Number(((await q.clone().count({ c: '*' }).first()) as { c: string }).c);
      else out[p.resource] = await q.delete();
    }
    if (!dryRun) {
      await recordAudit(t, { organizationId, actorId: null, actorType: 'system' }, { action: 'retention.run', resourceType: 'retention', metadata: { purged: out } });
    }
  });
  return out;
}

defineRoute({
  method: 'post', path: '/retention/run', module: M, summary: 'Run (or dry-run) retention for this organization',
  access: { permission: 'retention:manage' }, body: z.object({ dryRun: z.boolean().default(true) }), response: obj,
  async handler(c) {
    const report = await runRetention(c.svc, c.orgId(), c.body.dryRun);
    return { status: 200, data: { dryRun: c.body.dryRun, report } };
  },
});

jobRegistrars.push((svc) => {
  svc.jobs.work('retention', async () => {
    const orgs = await withPlatformScope(svc.db, 'retention-orgs', (t) => t('data_retention_policies').distinct('organization_id'));
    for (const o of orgs) await runRetention(svc, o.organization_id, false);
    // due deletion requests
    const due = await withPlatformScope(svc.db, 'deletion-due', (t) =>
      t('deletion_requests').where({ status: 'pending' }).where('execute_after', '<=', svc.now()));
    for (const d of due) {
      await withPlatformScope(svc.db, 'organization-purge', async (t) => {
        await t.raw('SELECT purge_organization(?)', [d.organization_id]);
      });
    }
  });
});

// ---- organization deletion (F-150) ---------------------------------------------------------------------------------

const GRACE_DAYS = 14;

defineRoute({
  method: 'post', path: '/organization/deletion-request', module: 'organizations', summary: 'Request organization deletion (grace period)',
  access: { permission: 'deletion:manage' }, allowSuspendedTenant: true,
  body: z.object({ confirmCode: z.string().min(1).max(60) }), response: obj,
  audit: { action: 'organization.deletion_requested', resourceType: 'organization' },
  async handler(c) {
    const org = await c.trx('organizations').where({ id: c.orgId() }).first();
    if (String(org.code).toLowerCase() !== c.body.confirmCode.toLowerCase()) {
      throw new AppError('VALIDATION_FAILED', 'Confirmation does not match the organization code', [{ field: 'confirmCode', issue: 'mismatch' }]);
    }
    const open = await c.trx('deletion_requests').where({ organization_id: c.orgId(), status: 'pending' }).first();
    if (open) throw new AppError('CONFLICT', 'A deletion request is already pending');
    const id = newId();
    const executeAfter = new Date(c.svc.now().getTime() + GRACE_DAYS * 86400_000);
    await c.trx('deletion_requests').insert({ id, organization_id: c.orgId(), requested_by: c.auth!.userId, execute_after: executeAfter, confirmation: c.body.confirmCode });
    await c.trx('organizations').where({ id: c.orgId() }).update({ status: 'suspended', suspended_reason: 'deletion requested', updated_at: c.svc.now() });
    return { status: 201, data: { id, executeAfter: executeAfter.toISOString(), status: 'pending' } };
  },
});

defineRoute({
  method: 'delete', path: '/organization/deletion-request', module: 'organizations', summary: 'Cancel a pending deletion request',
  access: { permission: 'deletion:manage' }, allowSuspendedTenant: true,
  audit: { action: 'organization.deletion_cancelled', resourceType: 'organization' },
  async handler(c) {
    const n = await c.trx('deletion_requests').where({ organization_id: c.orgId(), status: 'pending' }).update({ status: 'cancelled', decided_at: c.svc.now() });
    if (!n) throw new AppError('NOT_FOUND', 'No pending deletion request');
    await c.trx('organizations').where({ id: c.orgId(), status: 'suspended' }).update({ status: 'active', suspended_reason: null, updated_at: c.svc.now() });
    return { status: 204, auditResourceId: c.orgId() };
  },
});

// ---- schema history (F-151) ---------------------------------------------------------------------------------------

defineRoute({
  method: 'get', path: '/platform/schema-version', module: M, summary: 'Applied database migrations (read-only)',
  access: 'platformAdmin', response: obj,
  async handler(c) {
    const rows = await c.trx('knex_migrations').orderBy('id').select('name', 'batch', 'migration_time');
    return { data: { current: rows.at(-1)?.name ?? null, applied: rows.map((r) => rowToApi(r)) } };
  },
});

void listQuerySchema; void paginate;
export type { ListQuery };
