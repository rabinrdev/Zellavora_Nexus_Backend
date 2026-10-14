import { z } from 'zod';
import { defineRoute } from '../../platform/http/route.js';
import { AppError } from '../../platform/errors.js';

// ---- explicit permanent purge (F-146): soft-deleted rows only, honouring legal hold and the retention window -----------

const obj = z.record(z.string(), z.unknown());

const PURGEABLE: Record<string, string> = {
  departments: 'departments', locations: 'locations', teams: 'teams', projects: 'projects', tasks: 'tasks',
  customers: 'billing_customers', leads: 'leads', contacts: 'contacts', documents: 'documents', content_items: 'content_items', files: 'files',
};
const DEFAULT_PURGE_WINDOW_DAYS = 30;

defineRoute({
  method: 'post', path: '/retention/purge', module: 'data', summary: 'Permanently purge one soft-deleted record',
  access: { permission: 'retention:manage' }, idempotent: true,
  body: z.object({ resource: z.string().max(40), id: z.string().uuid() }), response: obj,
  audit: { action: 'record.purged', resourceType: 'record' },
  async handler(c) {
    const table = PURGEABLE[c.body.resource];
    if (!table) throw new AppError('VALIDATION_FAILED', 'Resource cannot be purged', [{ field: 'resource', issue: 'unsupported' }]);
    const policy = await c.trx('data_retention_policies').where({ organization_id: c.orgId(), resource: c.body.resource }).first();
    if (policy?.legal_hold) throw new AppError('CONFLICT', 'The resource is under legal hold');
    const row = await c.trx(table).where({ id: c.body.id, organization_id: c.orgId() }).first();
    if (!row) throw new AppError('NOT_FOUND', 'Record not found');
    if (!row.deleted_at) throw new AppError('CONFLICT', 'Only soft-deleted records can be purged; delete the record first');
    const windowDays = policy?.retention_days ?? DEFAULT_PURGE_WINDOW_DAYS;
    const eligibleAt = new Date(new Date(row.deleted_at).getTime() + windowDays * 86400_000);
    if (eligibleAt > c.svc.now()) {
      throw new AppError('CONFLICT', 'The retention window has not elapsed', [{ field: 'id', issue: `eligible_at:${eligibleAt.toISOString()}` }]);
    }
    try {
      await c.trx(table).where({ id: row.id }).delete();
    } catch (e) {
      if ((e as { code?: string }).code === '23503') throw new AppError('CONFLICT', 'The record is still referenced by other data');
      throw e;
    }
    if (table === 'files') await c.svc.storage.delete(row.object_key as string).catch(() => undefined);
    return { status: 200, data: { resource: c.body.resource, id: row.id, purged: true }, auditResourceId: row.id };
  },
});
