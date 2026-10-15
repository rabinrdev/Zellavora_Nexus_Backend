import { z } from 'zod';
import { defineRoute, type HandlerCtx } from '../../platform/http/route.js';
import { AppError } from '../../platform/errors.js';
import { newId } from '../../platform/crypto.js';
import { crudResource, rowToApi, mapDbError } from '../../platform/crud.js';
import { paginate, listQuerySchema, type ListQuery } from '../../platform/pagination.js';
import { assertDownloadable, fileDto, quotaFor, saveFile, signDownload } from '../../platform/files.js';
import { jobRegistrars } from '../../platform/job-handlers.js';
import { withPlatformScope, withTenant, type Trx } from '../../platform/scope.js';
import { registerExportKind } from '../data/exports.js';
import type { Services } from '../../platform/types.js';

const M = 'documents';
const FLAG = 'module.documents';
const obj = z.record(z.string(), z.unknown());
const uuid = z.string().uuid();
const idParams = z.object({ id: uuid });
const LEVEL = { view: 1, edit: 2, manage: 3 } as const;
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

crudResource({
  module: M, moduleFlag: FLAG, path: '/document-categories', table: 'document_categories', resource: 'document_categories', softDelete: true,
  create: z.object({ name: z.string().trim().min(2).max(120), parentId: uuid.nullable().optional() }),
  list: { sortable: { name: 'document_categories.name' }, defaultSort: 'name' },
  hooks: {
    async beforeCreate(c, trx, input) {
      const p = (input as { parentId?: string | null }).parentId;
      if (p && !(await trx('document_categories').where({ id: p, organization_id: c.orgId() }).whereNull('deleted_at').first())) {
        throw new AppError('VALIDATION_FAILED', 'Parent category not found', [{ field: 'parentId', issue: 'not_found' }]);
      }
    },
  },
});

/** Effective principals for ACL checks: the user, their roles (org scope) and their groups. */
async function principals(c: HandlerCtx) {
  const m = await c.trx('organization_memberships').where({ organization_id: c.orgId(), user_id: c.auth!.userId }).first();
  if (!m) return { roles: [] as string[], groups: [] as string[] };
  const roles = (await c.trx('user_role_assignments').where({ membership_id: m.id }).select('role_id')).map((r) => r.role_id as string);
  const groups = (await c.trx('user_group_members').where({ membership_id: m.id }).select('group_id')).map((g) => g.group_id as string);
  return { roles, groups };
}

/** Access = org RBAC (route permission) AND document ACL (when entries exist). */
async function docAccess(c: HandlerCtx, doc: { id: string; owner_id: string }, need: keyof typeof LEVEL): Promise<void> {
  if (doc.owner_id === c.auth!.userId || c.auth!.permissions.has('documents:manage_all')) return;
  const acl = await c.trx('document_acl').where({ document_id: doc.id });
  if (acl.length === 0) return; // no ACL: organization RBAC governs
  const p = await principals(c);
  const best = acl.filter((a) =>
    (a.principal_type === 'user' && a.principal_id === c.auth!.userId) ||
    (a.principal_type === 'role' && p.roles.includes(a.principal_id)) ||
    (a.principal_type === 'group' && p.groups.includes(a.principal_id)))
    .reduce((m, a) => Math.max(m, LEVEL[a.permission as keyof typeof LEVEL]), 0);
  if (best === 0) throw new AppError('NOT_FOUND', 'Document not found');
  if (best < LEVEL[need]) throw new AppError('FORBIDDEN', 'You do not have permission to perform this action');
}

async function loadDoc(c: HandlerCtx, id: string, need: keyof typeof LEVEL, includeDeleted = false) {
  const q = c.trx('documents').where({ id, organization_id: c.orgId() });
  if (!includeDeleted) q.whereNull('deleted_at');
  const d = await q.first();
  if (!d) throw new AppError('NOT_FOUND', 'Document not found');
  await docAccess(c, d, need);
  return d;
}

const docDto = async (trx: Trx, d: Record<string, unknown>) => {
  const v = await trx('document_versions as v').join('files as f', 'f.id', 'v.file_id').where({ 'v.document_id': d.id, 'v.version': d.current_version })
    .first('v.version', 'f.id as file_id', 'f.original_filename', 'f.content_type', 'f.size', 'f.scan_status');
  return { ...rowToApi(d), current: v ? { version: v.version, fileId: v.file_id, filename: v.original_filename, contentType: v.content_type, size: Number(v.size), scanStatus: v.scan_status } : null };
};

defineRoute({
  method: 'post', path: '/documents', module: M, moduleFlag: FLAG, summary: 'Upload a document (multipart: file + fields)',
  access: { permission: 'documents:create' }, upload: { field: 'file' }, rateLimit: 'search',
  body: z.object({ title: z.string().trim().min(1).max(200), description: z.string().max(2000).default(''), categoryId: uuid.optional(), expiresAt: date.optional() }),
  response: obj, audit: { action: 'document.created', resourceType: 'document' },
  async handler(c) {
    if (!c.req.file) throw new AppError('VALIDATION_FAILED', 'A file is required', [{ field: 'file', issue: 'required' }]);
    if (c.body.categoryId && !(await c.trx('document_categories').where({ id: c.body.categoryId, organization_id: c.orgId() }).whereNull('deleted_at').first())) {
      throw new AppError('VALIDATION_FAILED', 'Category not found', [{ field: 'categoryId', issue: 'not_found' }]);
    }
    const file = await saveFile(c.svc, c.trx, {
      organizationId: c.orgId(), ownerId: c.auth!.userId, filename: c.req.file.originalname, declaredType: c.req.file.mimetype, data: c.req.file.buffer, purpose: 'document',
    });
    const id = newId();
    await c.trx('documents').insert({
      id, organization_id: c.orgId(), title: c.body.title, description: c.body.description, category_id: c.body.categoryId ?? null,
      owner_id: c.auth!.userId, expires_at: c.body.expiresAt ?? null, created_by: c.auth!.userId, updated_by: c.auth!.userId,
    });
    await c.trx('document_versions').insert({ id: newId(), organization_id: c.orgId(), document_id: id, version: 1, file_id: file.id, created_by: c.auth!.userId });
    return { status: 201, data: await docDto(c.trx, await c.trx('documents').where({ id }).first()) };
  },
});

defineRoute({
  method: 'post', path: '/documents/:id/versions', module: M, moduleFlag: FLAG, summary: 'Upload a new version',
  access: { permission: 'documents:update' }, params: idParams, upload: { field: 'file' }, body: z.object({ note: z.string().max(300).optional() }), response: obj,
  audit: { action: 'document.version_added', resourceType: 'document' },
  async handler(c) {
    const d = await loadDoc(c, c.params.id, 'edit');
    if (!c.req.file) throw new AppError('VALIDATION_FAILED', 'A file is required', [{ field: 'file', issue: 'required' }]);
    const locked = await c.trx('documents').where({ id: d.id }).forUpdate().first();
    const file = await saveFile(c.svc, c.trx, {
      organizationId: c.orgId(), ownerId: c.auth!.userId, filename: c.req.file.originalname, declaredType: c.req.file.mimetype, data: c.req.file.buffer, purpose: 'document',
    });
    const version = locked.current_version + 1;
    await c.trx('document_versions').insert({ id: newId(), organization_id: c.orgId(), document_id: d.id, version, file_id: file.id, note: c.body.note ?? null, created_by: c.auth!.userId });
    await c.trx('documents').where({ id: d.id }).update({ current_version: version, updated_at: c.svc.now(), updated_by: c.auth!.userId, row_version: c.trx.raw('row_version + 1') });
    return { status: 201, data: { id: d.id, version }, auditResourceId: d.id };
  },
});

const docList = listQuerySchema.extend({ categoryId: uuid.optional(), expiringBefore: date.optional() });

defineRoute({
  method: 'get', path: '/documents', module: M, moduleFlag: FLAG, summary: 'Search documents (title/metadata) visible to me',
  access: { permission: 'documents:read' }, query: docList, response: obj,
  async handler(c) {
    const q = c.query as z.infer<typeof docList>;
    const p = await principals(c);
    const me = c.auth!.userId;
    const trash = (q as { deleted?: string }).deleted === 'only';
    if (trash && !c.auth!.permissions.has('documents:delete')) throw new AppError('FORBIDDEN', 'You do not have permission to perform this action');
    const qb = c.trx('documents').where({ organization_id: c.orgId() }).select('documents.*');
    if (trash) qb.whereNotNull('deleted_at');
    else qb.whereNull('deleted_at');
    if (!c.auth!.permissions.has('documents:manage_all')) {
      qb.where((w) => w.where('owner_id', me)
        .orWhereNotExists(c.trx('document_acl as a').whereRaw('a.document_id = documents.id').select(c.trx.raw('1')))
        .orWhereExists(c.trx('document_acl as a').whereRaw('a.document_id = documents.id').where((x) => {
          x.where((u) => u.where('a.principal_type', 'user').where('a.principal_id', me));
          if (p.roles.length) x.orWhere((r) => r.where('a.principal_type', 'role').whereIn('a.principal_id', p.roles));
          if (p.groups.length) x.orWhere((g) => g.where('a.principal_type', 'group').whereIn('a.principal_id', p.groups));
        }).select(c.trx.raw('1'))));
    }
    if (q.categoryId) qb.where({ category_id: q.categoryId });
    if (q.expiringBefore) qb.where('expires_at', '<=', q.expiringBefore);
    if (q.q) {
      const like = `%${q.q.replace(/[%_\\]/g, '\\$&')}%`;
      qb.where((w) => w.whereILike('title', like).orWhereExists(c.trx('document_metadata as m').whereRaw('m.document_id = documents.id').whereILike('m.value', like).select(c.trx.raw('1'))));
    }
    const page = await paginate(qb, q as ListQuery, { sortable: { title: 'documents.title', created_at: 'documents.created_at', expires_at: 'documents.expires_at' }, defaultSort: '-created_at', idColumn: 'documents.id' });
    return { data: page.data.map((r) => rowToApi(r)), meta: page.meta };
  },
});

defineRoute({
  method: 'get', path: '/documents/quota', module: M, moduleFlag: FLAG, summary: 'Storage quota status', access: { permission: 'documents:read' }, response: obj,
  async handler(c) {
    const u = await c.trx('storage_usage').where({ organization_id: c.orgId() }).first();
    const quota = await quotaFor(c.svc, c.trx, c.orgId());
    return { data: { usedBytes: Number(u?.bytes_used ?? 0), quotaBytes: quota, percentUsed: Math.round((Number(u?.bytes_used ?? 0) / quota) * 1000) / 10 } };
  },
});

defineRoute({
  method: 'get', path: '/documents/:id', module: M, moduleFlag: FLAG, summary: 'Document with current version and metadata',
  access: { permission: 'documents:read' }, params: idParams, response: obj,
  async handler(c) {
    const d = await loadDoc(c, c.params.id, 'view');
    const meta = await c.trx('document_metadata').where({ document_id: d.id }).orderBy('key');
    const versions = await c.trx('document_versions').where({ document_id: d.id }).orderBy('version', 'desc').select('version', 'note', 'created_at', 'file_id');
    return { data: { ...(await docDto(c.trx, d)), metadata: meta.map((m) => ({ key: m.key, type: m.value_type, value: m.value })), versions: versions.map((v) => rowToApi(v)) } };
  },
});

defineRoute({
  method: 'patch', path: '/documents/:id', module: M, moduleFlag: FLAG, summary: 'Update document details',
  access: { permission: 'documents:update' }, params: idParams,
  body: z.object({ title: z.string().trim().min(1).max(200).optional(), description: z.string().max(2000).optional(), categoryId: uuid.nullable().optional(), expiresAt: date.nullable().optional() }),
  response: obj, audit: { action: 'document.updated', resourceType: 'document' },
  async handler(c) {
    const d = await loadDoc(c, c.params.id, 'edit');
    if (Object.keys(c.body).length === 0) throw new AppError('VALIDATION_FAILED', 'No fields to update');
    const patch: Record<string, unknown> = { updated_at: c.svc.now(), updated_by: c.auth!.userId, row_version: c.trx.raw('row_version + 1') };
    if (c.body.title !== undefined) patch.title = c.body.title;
    if (c.body.description !== undefined) patch.description = c.body.description;
    if (c.body.categoryId !== undefined) patch.category_id = c.body.categoryId;
    if (c.body.expiresAt !== undefined) { patch.expires_at = c.body.expiresAt; patch.expiry_reminded_at = null; }
    await c.trx('documents').where({ id: d.id }).update(patch);
    return { status: 200, data: await docDto(c.trx, await c.trx('documents').where({ id: d.id }).first()) };
  },
});

defineRoute({
  method: 'delete', path: '/documents/:id', module: M, moduleFlag: FLAG, summary: 'Delete a document (soft)',
  access: { permission: 'documents:delete' }, params: idParams, audit: { action: 'document.deleted', resourceType: 'document' },
  async handler(c) {
    const d = await loadDoc(c, c.params.id, 'manage');
    await c.trx('documents').where({ id: d.id }).update({ deleted_at: c.svc.now(), deleted_by: c.auth!.userId });
    return { status: 204, auditResourceId: d.id };
  },
});

defineRoute({
  method: 'post', path: '/documents/:id/restore', module: M, moduleFlag: FLAG, summary: 'Restore a deleted document',
  access: { permission: 'documents:delete' }, params: idParams, response: obj, audit: { action: 'document.restored', resourceType: 'document' },
  async handler(c) {
    const d = await c.trx('documents').where({ id: c.params.id, organization_id: c.orgId() }).whereNotNull('deleted_at').first();
    if (!d) throw new AppError('NOT_FOUND', 'Document not found');
    await docAccess(c, d, 'manage');
    await c.trx('documents').where({ id: d.id }).update({ deleted_at: null, deleted_by: null });
    return { status: 200, data: { id: d.id, restored: true } };
  },
});

const metaItem = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,40}$/), type: z.enum(['string', 'number', 'date', 'boolean']), value: z.string().max(1000),
}).superRefine((m, ctx) => {
  if (m.type === 'number' && Number.isNaN(Number(m.value))) ctx.addIssue({ code: 'custom', message: 'must be a number', path: ['value'] });
  if (m.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(m.value)) ctx.addIssue({ code: 'custom', message: 'must be YYYY-MM-DD', path: ['value'] });
  if (m.type === 'boolean' && !['true', 'false'].includes(m.value)) ctx.addIssue({ code: 'custom', message: 'must be true or false', path: ['value'] });
});

defineRoute({
  method: 'put', path: '/documents/:id/metadata', module: M, moduleFlag: FLAG, summary: 'Replace typed metadata',
  access: { permission: 'documents:update' }, params: idParams, body: z.object({ items: z.array(metaItem).max(50) }), response: obj,
  audit: { action: 'document.metadata_changed', resourceType: 'document' },
  async handler(c) {
    const d = await loadDoc(c, c.params.id, 'edit');
    await c.trx('document_metadata').where({ document_id: d.id }).delete();
    if (c.body.items.length) {
      await c.trx('document_metadata').insert(c.body.items.map((i) => ({ id: newId(), organization_id: c.orgId(), document_id: d.id, key: i.key, value_type: i.type, value: i.value })));
    }
    return { status: 200, data: { id: d.id, items: c.body.items.length } };
  },
});

defineRoute({
  method: 'get', path: '/documents/:id/acl', module: M, moduleFlag: FLAG, summary: 'Document access list', access: { permission: 'documents:read' },
  params: idParams, response: obj,
  async handler(c) {
    const d = await loadDoc(c, c.params.id, 'manage');
    return { data: (await c.trx('document_acl').where({ document_id: d.id })).map((r) => rowToApi(r, ['organization_id'])) };
  },
});

defineRoute({
  method: 'put', path: '/documents/:id/acl', module: M, moduleFlag: FLAG, summary: 'Replace the document access list',
  access: { permission: 'documents:update' }, params: idParams,
  body: z.object({ entries: z.array(z.object({ principalType: z.enum(['user', 'role', 'group']), principalId: uuid, permission: z.enum(['view', 'edit', 'manage']) })).max(100) }),
  response: obj, audit: { action: 'document.acl_changed', resourceType: 'document' },
  async handler(c) {
    const d = await loadDoc(c, c.params.id, 'manage');
    for (const e of c.body.entries) {
      const ok = e.principalType === 'user'
        ? await c.trx('organization_memberships').where({ organization_id: c.orgId(), user_id: e.principalId, status: 'active' }).first()
        : e.principalType === 'group'
          ? await c.trx('user_groups').where({ id: e.principalId, organization_id: c.orgId() }).first()
          : await c.trx('roles').where({ id: e.principalId }).where((w) => w.whereNull('organization_id').orWhere({ organization_id: c.orgId() })).first();
      if (!ok) throw new AppError('VALIDATION_FAILED', 'Unknown principal', [{ field: 'entries', issue: `${e.principalType}:${e.principalId}` }]);
    }
    await c.trx('document_acl').where({ document_id: d.id }).delete();
    if (c.body.entries.length) {
      await c.trx('document_acl').insert(c.body.entries.map((e) => ({
        id: newId(), organization_id: c.orgId(), document_id: d.id, principal_type: e.principalType, principal_id: e.principalId, permission: e.permission,
      })));
    }
    return { status: 200, data: { id: d.id, entries: c.body.entries.length } };
  },
});

defineRoute({
  method: 'get', path: '/documents/:id/download-link', module: M, moduleFlag: FLAG, summary: 'Secure, time-limited download link',
  access: { permission: 'documents:read' }, params: idParams, query: z.object({ version: z.coerce.number().int().min(1).optional() }), response: obj,
  audit: { action: 'document.download_link_issued', resourceType: 'document' },
  async handler(c) {
    const d = await loadDoc(c, c.params.id, 'view');
    const v = await c.trx('document_versions').where({ document_id: d.id, version: c.query.version ?? d.current_version }).first();
    if (!v) throw new AppError('NOT_FOUND', 'Version not found');
    const f = await c.trx('files').where({ id: v.file_id }).first();
    assertDownloadable(f);
    const s = signDownload(c.svc.env.JWT_SECRET, f.id, c.orgId());
    return { status: 200, data: { url: `/api/v1/files/download/${s.token}`, expiresAt: s.expiresAt, file: fileDto(f) }, auditResourceId: d.id };
  },
});

/** Daily job: documents expiring within 7 days get exactly one reminder to the owner. */
export async function remindExpiringDocuments(svc: Services): Promise<number> {
  const horizon = new Date(svc.now().getTime() + 7 * 86400_000).toISOString().slice(0, 10);
  const rows = await withPlatformScope(svc.db, 'doc-expiry', (t) =>
    t('documents').whereNull('deleted_at').whereNotNull('expires_at').whereNull('expiry_reminded_at').where('expires_at', '<=', horizon).select('id', 'organization_id', 'owner_id', 'title', 'expires_at'));
  for (const d of rows) {
    await withTenant(svc.db, { organizationId: d.organization_id, userId: null }, async (trx) => {
      await trx('documents').where({ id: d.id }).update({ expiry_reminded_at: svc.now() });
      await svc.events.emit(trx, 'document.expiring', d.organization_id, { documentId: d.id, title: d.title, ownerId: d.owner_id, expiresOn: String(d.expires_at).slice(0, 10) });
    });
  }
  return rows.length;
}
jobRegistrars.push((svc) => { svc.jobs.work('reminders', async () => { await remindExpiringDocuments(svc); }); });

registerExportKind('documents', {
  permission: 'documents:manage_all', formats: ['csv', 'json'],
  async generate(_svc, trx, ctx) {
    const rows = await trx('documents').where({ organization_id: ctx.organizationId }).whereNull('deleted_at').orderBy('created_at', 'desc')
      .select('title', 'category_id', 'owner_id', 'current_version', 'expires_at', 'created_at');
    return { rows, filename: 'documents' };
  },
});

void mapDbError;
