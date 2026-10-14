import { z } from 'zod';
import { defineRoute, type HandlerCtx } from '../../platform/http/route.js';
import { AppError } from '../../platform/errors.js';
import { newId, randomToken, sha256 } from '../../platform/crypto.js';
import { crudResource, rowToApi } from '../../platform/crud.js';
import { paginate, listQuerySchema, type ListQuery } from '../../platform/pagination.js';
import { verifyPassword } from '../../platform/auth/password.js';
import { recordAudit } from '../../platform/audit.js';
import { bumpPermissionVersion } from '../../platform/authz.js';
import { validateOrgCode, CODE_FORMAT, RESERVED_CODES } from './provision.js';
import { inviteUser, INVITATION_TTL_HOURS } from './invitations.js';
import { SYSTEM_ROLE_IDS } from '../iam/system-roles.js';
import { membershipFor } from '../iam/service.js';

const M = 'organizations';
const uuid = z.string().uuid();
const obj = z.record(z.string(), z.unknown());
const idParams = z.object({ id: uuid });

const PUBLIC_COLUMNS = ['id', 'name', 'code', 'slug', 'type', 'status', 'timezone', 'locale', 'currency', 'owner_user_id', 'logo_file_id', 'branding', 'row_version', 'created_at', 'updated_at'];

const currency = z.string().length(3).regex(/^[A-Za-z]{3}$/).transform((s) => s.toUpperCase());
const timezone = z.string().min(1).max(64).refine((tz) => {
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; }
}, 'unknown timezone');

defineRoute({
  method: 'get', path: '/organization', module: M, summary: 'Organization profile and branding',
  access: { permission: 'organization:read' }, allowSuspendedTenant: true, response: obj,
  async handler(c) {
    const org = await c.trx('organizations').where({ id: c.orgId() }).first(PUBLIC_COLUMNS);
    return { data: rowToApi(org) };
  },
});

async function applyProfile(c: HandlerCtx, patch: Record<string, unknown>, rowVersion?: number) {
  const org = await c.trx('organizations').where({ id: c.orgId() }).forUpdate().first();
  if (rowVersion !== undefined && org.row_version !== rowVersion) {
    throw new AppError('PRECONDITION_FAILED', 'The organization was modified by someone else; reload and retry');
  }
  if (patch.logo_file_id) {
    const f = await c.trx('files').where({ id: patch.logo_file_id, organization_id: c.orgId() }).whereNull('deleted_at').first();
    if (!f || !f.content_type.startsWith('image/')) throw new AppError('VALIDATION_FAILED', 'Logo must be an uploaded image', [{ field: 'logoFileId', issue: 'invalid' }]);
  }
  await c.trx('organizations').where({ id: c.orgId() }).update({ ...patch, updated_at: c.svc.now(), row_version: c.trx.raw('row_version + 1') });
  const updated = await c.trx('organizations').where({ id: c.orgId() }).first(PUBLIC_COLUMNS);
  await c.emit('organization.updated', { fields: Object.keys(patch) });
  return { data: rowToApi(updated), auditResourceId: c.orgId() };
}

defineRoute({
  method: 'patch', path: '/organization', module: M, summary: 'Update organization profile and branding',
  access: { permission: 'organization:update' },
  body: z.object({
    name: z.string().trim().min(2).max(120).optional(),
    logoFileId: uuid.nullable().optional(),
    branding: z.object({
      primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
      accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
      tagline: z.string().max(160).optional(),
    }).optional(),
    rowVersion: z.number().int().optional(),
  }),
  response: obj, audit: { action: 'organization.updated', resourceType: 'organization' },
  async handler(c) {
    const { rowVersion, logoFileId, branding, ...rest } = c.body;
    const patch: Record<string, unknown> = { ...rest };
    if (logoFileId !== undefined) patch.logo_file_id = logoFileId;
    if (branding) patch.branding = JSON.stringify(branding);
    return applyProfile(c, patch, rowVersion);
  },
});

defineRoute({
  method: 'patch', path: '/organization/defaults', module: M, summary: 'Set default timezone, locale and currency',
  access: { permission: 'organization:update' },
  body: z.object({ timezone: timezone.optional(), locale: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/).optional(), currency: currency.optional() }),
  response: obj, audit: { action: 'organization.defaults_changed', resourceType: 'organization' },
  async handler(c) { return applyProfile(c, c.body); },
});

defineRoute({
  method: 'get', path: '/organization/code-availability', module: M, summary: 'Check if an organization code is available',
  access: 'public', rateLimit: 'search', query: z.object({ code: z.string().trim().toLowerCase().min(1).max(40) }), response: obj,
  async handler(c) {
    const code = c.query.code;
    if (!CODE_FORMAT.test(code)) return { status: 200, data: { available: false, reason: 'invalid_format' } };
    if (RESERVED_CODES.has(code)) return { status: 200, data: { available: false, reason: 'reserved' } };
    const taken = await c.trx('organizations').whereRaw('code = ? OR slug = ?', [code, code]).first('id');
    return { status: 200, data: { available: !taken, ...(taken ? { reason: 'taken' } : {}) } };
  },
});

defineRoute({
  method: 'get', path: '/me/organizations', module: M, summary: 'Organizations the caller belongs to',
  access: 'authenticated', scope: 'user', allowSuspendedTenant: true, response: obj,
  async handler(c) {
    const rows = await c.trx.raw(
      `SELECT o.id, o.name, o.code::text AS code, o.type, o.status, (o.id = ?) AS active
         FROM organization_memberships m JOIN organizations o ON o.id = m.organization_id
        WHERE m.user_id = ? AND m.status = 'active' ORDER BY o.name`, [c.auth!.organizationId ?? '', c.auth!.userId]);
    return { data: rows.rows };
  },
});

// ---- lifecycle (platform) --------------------------------------------------------------------------------

const TRANSITIONS: Record<string, string[]> = {
  pending: ['active', 'closed'], active: ['suspended', 'closed'], suspended: ['active', 'closed'], closed: [],
};

for (const [verb, target] of [['suspend', 'suspended'], ['reactivate', 'active']] as const) {
  defineRoute({
    method: 'post', path: `/organization/${verb}`, module: M, summary: `${verb} an organization (platform admin)`,
    access: 'platformAdmin', body: z.object({ organizationId: uuid, reason: z.string().trim().min(3).max(300) }), response: obj,
    async handler(c) {
      const org = await c.trx('organizations').where({ id: c.body.organizationId }).forUpdate().first();
      if (!org) throw new AppError('NOT_FOUND', 'Organization not found');
      if (!TRANSITIONS[org.status]!.includes(target)) throw new AppError('CONFLICT', `Cannot change status from ${org.status} to ${target}`);
      await c.trx('organizations').where({ id: org.id }).update({
        status: target, suspended_reason: target === 'suspended' ? c.body.reason : null, updated_at: c.svc.now(),
        row_version: c.trx.raw('row_version + 1'),
      });
      await recordAudit(c.trx, { ...c.meta, organizationId: org.id }, {
        action: `organization.${verb}`, resourceType: 'organization', resourceId: org.id, metadata: { reason: c.body.reason },
      });
      return { status: 200, data: { id: org.id, status: target } };
    },
  });
}

// ---- departments & locations -------------------------------------------------------------------------------

crudResource({
  module: M, path: '/departments', table: 'departments', resource: 'departments', softDelete: true, rowVersion: true,
  create: z.object({
    name: z.string().trim().min(2).max(120), parentId: uuid.nullable().optional(), headUserId: uuid.nullable().optional(),
  }),
  list: { sortable: { name: 'departments.name', created_at: 'departments.created_at' }, filterable: { parent_id: 'departments.parent_id' }, defaultSort: 'name' },
  searchColumns: ['departments.name'],
  hooks: {
    async beforeCreate(c, trx, input) {
      const i = input as { parentId?: string | null; headUserId?: string | null };
      if (i.parentId) {
        const p = await trx('departments').where({ id: i.parentId, organization_id: c.orgId() }).whereNull('deleted_at').first();
        if (!p) throw new AppError('VALIDATION_FAILED', 'Parent department not found', [{ field: 'parentId', issue: 'not_found' }]);
      }
      if (i.headUserId && !(await membershipFor(trx, c.orgId(), i.headUserId))) {
        throw new AppError('VALIDATION_FAILED', 'Head must be a member', [{ field: 'headUserId', issue: 'not_member' }]);
      }
    },
    async beforeUpdate(c, trx, input, existing) {
      const i = input as { parentId?: string | null };
      if (i.parentId) {
        if (i.parentId === existing.id) throw new AppError('CONFLICT', 'A department cannot be its own parent');
        const cyc = await trx.raw(
          `WITH RECURSIVE anc AS (
             SELECT id, parent_id FROM departments WHERE id = ? AND organization_id = ?
             UNION SELECT d.id, d.parent_id FROM departments d JOIN anc a ON d.id = a.parent_id)
           SELECT 1 FROM anc WHERE id = ?`, [i.parentId, c.orgId(), existing.id as string]);
        if (cyc.rows.length > 0) throw new AppError('CONFLICT', 'Department hierarchy cannot contain cycles');
      }
    },
    async beforeDelete(c, trx, existing) {
      const child = await trx('departments').where({ parent_id: existing.id }).whereNull('deleted_at').first();
      if (child) throw new AppError('CONFLICT', 'Department has child departments');
    },
  },
});

crudResource({
  module: M, path: '/locations', table: 'locations', resource: 'locations', softDelete: true, rowVersion: true,
  create: z.object({ name: z.string().trim().min(2).max(120), address: z.string().max(500).nullable().optional(), timezone: timezone.nullable().optional() }),
  list: { sortable: { name: 'locations.name', created_at: 'locations.created_at' }, defaultSort: 'name' },
  searchColumns: ['locations.name'],
});

// ---- invitations --------------------------------------------------------------------------------------------

defineRoute({
  method: 'post', path: '/invitations', module: M, summary: 'Invite a person to the organization',
  access: { permission: 'invitations:create' }, rateLimit: 'invitation',
  entitlement: { key: 'max_members', count: async ({ trx, orgId }) => Number(((await trx('organization_memberships').where({ organization_id: orgId }).whereIn('status', ['active', 'suspended']).count({ c: '*' }).first()) as { c: string }).c) },
  body: z.object({ email: z.string().trim().toLowerCase().email().max(254), roleId: uuid.optional() }), response: obj,
  audit: { action: 'invitation.created', resourceType: 'invitation' },
  async handler(c) { return { status: 201, data: await inviteUser(c, c.body.email, c.body.roleId) }; },
});

defineRoute({
  method: 'get', path: '/invitations', module: M, summary: 'List invitations', access: { permission: 'invitations:read' },
  query: listQuerySchema, response: obj,
  async handler(c) {
    const qb = c.trx('invitations').where({ organization_id: c.orgId() }).select('id', 'email', 'role_id', 'status', 'expires_at', 'invited_by', 'created_at', 'accepted_at', 'revoked_at');
    const page = await paginate(qb, c.query as ListQuery, {
      sortable: { created_at: 'created_at', email: 'email' }, filterable: { status: 'status' }, defaultSort: '-created_at',
    });
    return { data: page.data.map((r) => rowToApi(r)), meta: page.meta };
  },
});

defineRoute({
  method: 'post', path: '/invitations/:id/revoke', module: M, summary: 'Revoke a pending invitation',
  access: { permission: 'invitations:delete' }, params: idParams, response: obj,
  audit: { action: 'invitation.revoked', resourceType: 'invitation' },
  async handler(c) {
    const n = await c.trx('invitations').where({ id: c.params.id, organization_id: c.orgId(), status: 'pending' })
      .update({ status: 'revoked', revoked_at: c.svc.now() });
    if (!n) throw new AppError('NOT_FOUND', 'Pending invitation not found');
    return { status: 200, data: { id: c.params.id, status: 'revoked' } };
  },
});

defineRoute({
  method: 'post', path: '/invitations/:id/resend', module: M, summary: 'Resend an invitation with a fresh token',
  access: { permission: 'invitations:create' }, params: idParams, rateLimit: 'invitation', response: obj,
  audit: { action: 'invitation.resent', resourceType: 'invitation' },
  async handler(c) {
    const inv = await c.trx('invitations').where({ id: c.params.id, organization_id: c.orgId(), status: 'pending' }).first();
    if (!inv) throw new AppError('NOT_FOUND', 'Pending invitation not found');
    const token = randomToken();
    await c.trx('invitations').where({ id: inv.id }).update({
      token_hash: sha256(token), expires_at: new Date(c.svc.now().getTime() + INVITATION_TTL_HOURS * 3600_000),
    });
    await c.svc.mail.send({ to: inv.email, subject: 'Your invitation', text: `Your invitation token: ${token}` });
    return { status: 200, data: { id: inv.id, status: 'pending' } };
  },
});

// ---- ownership transfer (F-193) -----------------------------------------------------------------------------

defineRoute({
  method: 'post', path: '/organization/transfer-ownership', module: M, summary: 'Start an ownership transfer (password re-confirmation)',
  access: { permission: 'organization:transfer' }, body: z.object({ newOwnerUserId: uuid, password: z.string().min(1).max(256) }),
  response: obj, audit: { action: 'organization.ownership_transfer_requested', resourceType: 'organization' },
  async handler(c) {
    const org = await c.trx('organizations').where({ id: c.orgId() }).first();
    if (org.owner_user_id !== c.auth!.userId) throw new AppError('FORBIDDEN', 'Only the current owner can transfer ownership');
    const me = await c.svc.db('users').where({ id: c.auth!.userId }).first();
    if (!(await verifyPassword(me.password_hash, c.body.password))) throw new AppError('FORBIDDEN', 'Password confirmation failed');
    if (c.body.newOwnerUserId === c.auth!.userId) throw new AppError('VALIDATION_FAILED', 'Choose a different user');
    const m = await membershipFor(c.trx, c.orgId(), c.body.newOwnerUserId);
    if (!m || m.status !== 'active') throw new AppError('VALIDATION_FAILED', 'Recipient must be an active member', [{ field: 'newOwnerUserId', issue: 'not_member' }]);
    await c.trx('ownership_transfers').where({ organization_id: c.orgId(), status: 'pending' }).update({ status: 'cancelled', decided_at: c.svc.now() });
    const id = newId();
    await c.trx('ownership_transfers').insert({
      id, organization_id: c.orgId(), from_user_id: c.auth!.userId, to_user_id: c.body.newOwnerUserId,
      expires_at: new Date(c.svc.now().getTime() + 7 * 86400_000),
    });
    return { status: 201, data: { id, status: 'pending' } };
  },
});

defineRoute({
  method: 'post', path: '/organization/transfer-ownership/:id/accept', module: M, summary: 'Accept an ownership transfer (recipient)',
  access: 'authenticated', params: idParams, response: obj,
  audit: { action: 'organization.ownership_transferred', resourceType: 'organization' },
  async handler(c) {
    const t = await c.trx('ownership_transfers').where({ id: c.params.id, organization_id: c.orgId(), status: 'pending' }).forUpdate().first();
    if (!t || t.to_user_id !== c.auth!.userId) throw new AppError('NOT_FOUND', 'Transfer not found');
    if (new Date(t.expires_at) < c.svc.now()) {
      await c.trx('ownership_transfers').where({ id: t.id }).update({ status: 'expired', decided_at: c.svc.now() });
      throw new AppError('CONFLICT', 'Transfer has expired');
    }
    const m = await membershipFor(c.trx, c.orgId(), c.auth!.userId);
    if (!m) throw new AppError('NOT_FOUND', 'Transfer not found');
    await c.trx('organizations').where({ id: c.orgId() }).update({ owner_user_id: c.auth!.userId, updated_at: c.svc.now(), row_version: c.trx.raw('row_version + 1') });
    const has = await c.trx('user_role_assignments').where({ membership_id: m.id, role_id: SYSTEM_ROLE_IDS.org_admin, scope_type: 'organization' }).first();
    if (!has) {
      await c.trx('user_role_assignments').insert({
        id: newId(), organization_id: c.orgId(), membership_id: m.id, role_id: SYSTEM_ROLE_IDS.org_admin, scope_type: 'organization', created_by: t.from_user_id,
      });
    }
    await c.trx('ownership_transfers').where({ id: t.id }).update({ status: 'accepted', decided_at: c.svc.now() });
    await bumpPermissionVersion(c.trx, [c.auth!.userId]);
    return { status: 200, data: { organizationId: c.orgId(), ownerUserId: c.auth!.userId } };
  },
});

defineRoute({
  method: 'post', path: '/organization/transfer-ownership/:id/cancel', module: M, summary: 'Cancel a pending transfer',
  access: { permission: 'organization:transfer' }, params: idParams, response: obj,
  async handler(c) {
    const n = await c.trx('ownership_transfers').where({ id: c.params.id, organization_id: c.orgId(), status: 'pending' })
      .update({ status: 'cancelled', decided_at: c.svc.now() });
    if (!n) throw new AppError('NOT_FOUND', 'Transfer not found');
    return { status: 200, data: { id: c.params.id, status: 'cancelled' } };
  },
});

void validateOrgCode;
