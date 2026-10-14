import { z } from 'zod';
import { defineRoute } from '../../platform/http/route.js';
import { AppError } from '../../platform/errors.js';
import {
  assertDownloadable, fileDto, quotaFor, saveFile, signDownload, verifyDownload,
} from '../../platform/files.js';
import { withTenant } from '../../platform/scope.js';
import { recordAudit } from '../../platform/audit.js';
import { paginate, listQuerySchema, type ListQuery } from '../../platform/pagination.js';

const M = 'files';
const obj = z.record(z.string(), z.unknown());
const idParams = z.object({ id: z.string().uuid() });

defineRoute({
  method: 'post', path: '/files', module: M, summary: 'Upload a file (multipart, field "file")',
  access: { permission: 'files:upload' }, upload: { field: 'file' }, rateLimit: 'search',
  body: z.object({ purpose: z.string().max(40).default('general') }), response: obj,
  audit: { action: 'file.uploaded', resourceType: 'file' },
  async handler(c) {
    const f = c.req.file;
    if (!f) throw new AppError('VALIDATION_FAILED', 'A file is required', [{ field: 'file', issue: 'required' }]);
    const saved = await saveFile(c.svc, c.trx, {
      organizationId: c.orgId(), ownerId: c.auth!.userId, filename: f.originalname,
      declaredType: f.mimetype, data: f.buffer, purpose: c.body.purpose,
    });
    return { status: 201, data: saved };
  },
});

defineRoute({
  method: 'get', path: '/files', module: M, summary: 'List files', access: { permission: 'files:read' },
  query: listQuerySchema, response: obj,
  async handler(c) {
    const qb = c.trx('files').where({ organization_id: c.orgId() }).whereNull('deleted_at');
    const page = await paginate(qb, c.query as ListQuery, {
      sortable: { created_at: 'created_at', size: 'size', filename: 'original_filename' },
      filterable: { purpose: 'purpose', scan_status: 'scan_status' }, defaultSort: '-created_at',
    });
    return { data: page.data.map((r) => fileDto(r)), meta: page.meta };
  },
});

async function loadFile(c: { trx: import('../../platform/scope.js').Trx; orgId(): string }, id: string) {
  const f = await c.trx('files').where({ id, organization_id: c.orgId() }).whereNull('deleted_at').first();
  if (!f) throw new AppError('NOT_FOUND', 'File not found');
  return f;
}

defineRoute({
  method: 'get', path: '/files/usage', module: M, summary: 'Storage usage and quota',
  access: { permission: 'files:read' }, response: obj,
  async handler(c) {
    const u = await c.trx('storage_usage').where({ organization_id: c.orgId() }).first();
    const quota = await quotaFor(c.svc, c.trx, c.orgId());
    const used = Number(u?.bytes_used ?? 0);
    return { data: { usedBytes: used, quotaBytes: quota, remainingBytes: Math.max(0, quota - used) } };
  },
});

defineRoute({
  method: 'get', path: '/files/download/:token', module: M, summary: 'Download via a time-limited signed link',
  access: 'public', rateLimit: 'search', params: z.object({ token: z.string().min(20).max(1024) }), binary: true,
  async handler(c) {
    const v = verifyDownload(c.svc.env.JWT_SECRET, c.params.token);
    if (!v) throw new AppError('NOT_FOUND', 'Link is invalid or has expired');
    return withTenant(c.svc.db, { organizationId: v.organizationId, userId: null }, async (trx) => {
      const f = await trx('files').where({ id: v.fileId, organization_id: v.organizationId }).first();
      if (!f) throw new AppError('NOT_FOUND', 'File not found');
      assertDownloadable(f);
      const body = await c.svc.storage.get(f.object_key);
      await recordAudit(trx, { organizationId: v.organizationId, actorId: null, actorType: 'signed_link', correlationId: c.requestId, ip: c.ip },
        { action: 'file.downloaded', resourceType: 'file', resourceId: f.id });
      return { status: 200, raw: { contentType: f.content_type, body, filename: f.original_filename } };
    });
  },
});

defineRoute({
  method: 'get', path: '/files/:id', module: M, summary: 'File metadata and preview info', access: { permission: 'files:read' },
  params: idParams, response: obj,
  async handler(c) { return { data: fileDto(await loadFile(c, c.params.id)) }; },
});

defineRoute({
  method: 'get', path: '/files/:id/download-link', module: M, summary: 'Short-lived signed download link',
  access: { permission: 'files:read' }, params: idParams, response: obj,
  async handler(c) {
    const f = await loadFile(c, c.params.id);
    assertDownloadable(f);
    const { token, expiresAt } = signDownload(c.svc.env.JWT_SECRET, f.id, c.orgId());
    return { data: { url: `/api/v1/files/download/${token}`, expiresAt } };
  },
});

defineRoute({
  method: 'get', path: '/files/:id/content', module: M, summary: 'Stream a file through the API',
  access: { permission: 'files:read' }, params: idParams, binary: true,
  async handler(c) {
    const f = await loadFile(c, c.params.id);
    assertDownloadable(f);
    await c.audit({ action: 'file.downloaded', resourceType: 'file', resourceId: f.id });
    return { status: 200, raw: { contentType: f.content_type, body: await c.svc.storage.get(f.object_key), filename: f.original_filename } };
  },
});

defineRoute({
  method: 'delete', path: '/files/:id', module: M, summary: 'Delete a file', access: { permission: 'files:delete' },
  params: idParams, audit: { action: 'file.deleted', resourceType: 'file' },
  async handler(c) {
    const f = await loadFile(c, c.params.id);
    await c.trx('files').where({ id: f.id }).update({ deleted_at: c.svc.now(), deleted_by: c.auth!.userId });
    await c.trx('storage_usage').where({ organization_id: c.orgId() })
      .update({ bytes_used: c.trx.raw('GREATEST(bytes_used - ?, 0)', [Number(f.size)]), updated_at: c.svc.now() });
    await c.svc.storage.delete(f.object_key);
    return { status: 204, auditResourceId: f.id };
  },
});
