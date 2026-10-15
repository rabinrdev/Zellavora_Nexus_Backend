import { z } from 'zod';
import { defineRoute, type HandlerCtx } from '../../platform/http/route.js';
import { AppError } from '../../platform/errors.js';
import { newId, randomToken, sha256 } from '../../platform/crypto.js';
import { paginate, listQuerySchema, type ListQuery } from '../../platform/pagination.js';
import { bumpPermissionVersion } from '../../platform/authz.js';
import { crudResource, rowToApi, mapDbError } from '../../platform/crud.js';
import { revokeAllSessions } from '../auth/service.js';
import { recordSecurityEvent } from '../../platform/audit.js';
import {
  activeAdminCount, approvalsRequired, assertCanGrant, getRole, grantRole, logAccess, membershipFor,
  revokeRole, rolePermissionKeys,
} from './service.js';
import { SYSTEM_ROLE_IDS } from './system-roles.js';
import { buildMenu, menuFlagKeys } from './menu.js';
import { isFlagEnabled } from '../../platform/flags.js';
import { inviteUser } from '../organizations/invitations.js';

const M = 'iam';
const uuid = z.string().uuid();
const idParams = z.object({ id: uuid });
const obj = z.record(z.string(), z.unknown());
const actor = (c: HandlerCtx) => ({ userId: c.auth!.userId, organizationId: c.orgId() });

// ---- users (members of the organization) -------------------------------------------------------------------

const userRow = (r: Record<string, unknown>, roles: unknown[] = []) => ({
  userId: r.user_id, membershipId: r.membership_id, email: r.email, name: r.name, status: r.status,
  userStatus: r.user_status, joinedAt: r.joined_at ? new Date(r.joined_at as string).toISOString() : null, roles,
});

async function rolesFor(c: HandlerCtx, membershipIds: string[]) {
  if (membershipIds.length === 0) return new Map<string, unknown[]>();
  const rows = await c.trx('user_role_assignments as ura').join('roles as r', 'r.id', 'ura.role_id')
    .whereIn('ura.membership_id', membershipIds)
    .select('ura.membership_id', 'r.id', 'r.key', 'r.name', 'ura.scope_type', 'ura.scope_id');
  const map = new Map<string, unknown[]>();
  for (const r of rows) {
    const list = map.get(r.membership_id) ?? [];
    list.push({ id: r.id, key: r.key, name: r.name, scopeType: r.scope_type, scopeId: r.scope_id });
    map.set(r.membership_id, list);
  }
  return map;
}

defineRoute({
  method: 'get', path: '/users', module: M, summary: 'List members of the organization',
  access: { permission: 'users:read' }, query: listQuerySchema, response: obj,
  async handler(c) {
    const qb = c.trx('organization_memberships as m').join('users as u', 'u.id', 'm.user_id')
      .where('m.organization_id', c.orgId()).whereNot('m.status', 'removed')
      .select('m.id as membership_id', 'u.id as user_id', 'u.email', 'u.name', 'm.status', 'u.status as user_status', 'm.joined_at');
    const q = c.query as ListQuery;
    if (q.q) qb.where((w) => w.whereILike('u.name', `%${q.q}%`).orWhereILike('u.email', `%${q.q}%`));
    const page = await paginate(qb, q, {
      sortable: { name: 'u.name', email: 'u.email', joined_at: 'm.joined_at', created_at: 'm.created_at' },
      filterable: { status: 'm.status' }, defaultSort: 'name', idColumn: 'm.id',
    });
    const roles = await rolesFor(c, page.data.map((r) => r.membership_id as string));
    return { data: page.data.map((r) => userRow(r, roles.get(r.membership_id as string) ?? [])), meta: page.meta };
  },
});

async function loadMember(c: HandlerCtx, userId: string) {
  const row = await c.trx('organization_memberships as m').join('users as u', 'u.id', 'm.user_id')
    .where({ 'm.organization_id': c.orgId(), 'm.user_id': userId }).whereNot('m.status', 'removed')
    .select('m.id as membership_id', 'u.id as user_id', 'u.email', 'u.name', 'm.status', 'u.status as user_status', 'm.joined_at').first();
  if (!row) throw new AppError('NOT_FOUND', 'User not found');
  return row;
}

defineRoute({
  method: 'get', path: '/users/:id', module: M, summary: 'Get a member', access: { permission: 'users:read' },
  params: idParams, response: obj,
  async handler(c) {
    const row = await loadMember(c, c.params.id);
    const roles = await rolesFor(c, [row.membership_id]);
    return { data: userRow(row, roles.get(row.membership_id) ?? []) };
  },
});

defineRoute({
  method: 'post', path: '/users', module: M, summary: 'Create a member (sends an invitation)',
  access: { permission: 'users:create' }, rateLimit: 'invitation',
  body: z.object({ email: z.string().trim().toLowerCase().email().max(254), roleId: uuid.optional() }), response: obj,
  audit: { action: 'user.invited', resourceType: 'invitation' },
  async handler(c) {
    const inv = await inviteUser(c, c.body.email, c.body.roleId);
    return { status: 201, data: inv };
  },
});

defineRoute({
  method: 'patch', path: '/users/:id/status', module: M, summary: 'Deactivate or reactivate a member',
  access: { permission: 'users:update' }, params: idParams, body: z.object({ status: z.enum(['active', 'suspended']), reason: z.string().max(300).optional() }),
  response: obj, audit: { action: 'user.status_changed', resourceType: 'user' },
  async handler(c) {
    const m = await loadMember(c, c.params.id);
    if (m.user_id === c.auth!.userId) throw new AppError('CONFLICT', 'You cannot change your own status');
    if (c.body.status === 'suspended') {
      const isAdmin = await c.trx('user_role_assignments').where({ membership_id: m.membership_id, role_id: SYSTEM_ROLE_IDS.org_admin }).first();
      if (isAdmin && (await activeAdminCount(c.trx, c.orgId(), m.membership_id)) === 0) {
        throw new AppError('CONFLICT', 'The last Organization Admin cannot be deactivated');
      }
    }
    await c.trx('organization_memberships').where({ id: m.membership_id }).update({ status: c.body.status, updated_at: c.svc.now(), updated_by: c.auth!.userId });
    await c.trx('membership_history').insert({
      id: newId(), organization_id: c.orgId(), user_id: m.user_id, actor_id: c.auth!.userId,
      change: c.body.status === 'suspended' ? 'deactivated' : 'reactivated', note: c.body.reason ?? null,
    });
    // revocation is immediate: sessions for this org die and permission version moves
    await c.trx('sessions').where({ user_id: m.user_id, active_organization_id: c.orgId() }).whereNull('revoked_at')
      .update({ revoked_at: c.svc.now(), revoked_reason: `membership_${c.body.status}` });
    await bumpPermissionVersion(c.trx, [m.user_id]);
    await c.emit('user.status_changed', { userId: m.user_id, status: c.body.status });
    return { data: { userId: m.user_id, status: c.body.status }, auditResourceId: m.user_id };
  },
});

defineRoute({
  method: 'delete', path: '/users/:id', module: M, summary: 'Remove a member from the organization',
  access: { permission: 'users:delete' }, params: idParams, audit: { action: 'user.removed', resourceType: 'user' },
  async handler(c) {
    const m = await loadMember(c, c.params.id);
    if (m.user_id === c.auth!.userId) throw new AppError('CONFLICT', 'You cannot remove yourself');
    const isAdmin = await c.trx('user_role_assignments').where({ membership_id: m.membership_id, role_id: SYSTEM_ROLE_IDS.org_admin }).first();
    if (isAdmin && (await activeAdminCount(c.trx, c.orgId(), m.membership_id)) === 0) {
      throw new AppError('CONFLICT', 'The last Organization Admin cannot be removed');
    }
    await c.trx('user_role_assignments').where({ membership_id: m.membership_id }).delete();
    await c.trx('user_group_members').where({ membership_id: m.membership_id }).delete();
    await c.trx('organization_memberships').where({ id: m.membership_id }).update({ status: 'removed', updated_at: c.svc.now(), updated_by: c.auth!.userId });
    await c.trx('membership_history').insert({ id: newId(), organization_id: c.orgId(), user_id: m.user_id, actor_id: c.auth!.userId, change: 'removed' });
    await c.trx('sessions').where({ user_id: m.user_id, active_organization_id: c.orgId() }).whereNull('revoked_at')
      .update({ revoked_at: c.svc.now(), revoked_reason: 'membership_removed' });
    await bumpPermissionVersion(c.trx, [m.user_id]);
    await c.emit('user.removed', { userId: m.user_id });
    return { status: 204, auditResourceId: m.user_id };
  },
});

// ---- role assignment ---------------------------------------------------------------------------------------

defineRoute({
  method: 'post', path: '/users/:id/roles', module: M, summary: 'Assign a role to a member',
  access: { permission: 'roles:assign' }, params: idParams,
  body: z.object({ roleId: uuid, reason: z.string().max(300).optional(), scopeType: z.string().max(40).optional(), scopeId: uuid.optional() }),
  response: obj, audit: { action: 'role.assigned', resourceType: 'user' },
  async handler(c) {
    const m = await loadMember(c, c.params.id);
    const role = await getRole(c.trx, c.orgId(), c.body.roleId);
    await assertCanGrant(c.trx, c.auth!, await rolePermissionKeys(c.trx, role.id));
    if (role.privileged && (await approvalsRequired(c.trx, c.orgId()))) {
      const id = newId();
      await c.trx('permission_change_requests').insert({
        id, organization_id: c.orgId(), requested_by: c.auth!.userId, change_type: 'grant_role',
        payload: JSON.stringify({ membershipId: m.membership_id, userId: m.user_id, roleId: role.id, reason: c.body.reason }),
      });
      return { status: 202, data: { pendingApproval: true, requestId: id }, auditResourceId: id };
    }
    await grantRole(c.trx, actor(c), m.membership_id, m.user_id, role.id, c.body.reason,
      c.body.scopeType && c.body.scopeId ? { type: c.body.scopeType, id: c.body.scopeId } : undefined);
    await c.emit('role.assigned', { userId: m.user_id, roleId: role.id });
    return { status: 201, data: { userId: m.user_id, roleId: role.id }, auditResourceId: m.user_id };
  },
});

defineRoute({
  method: 'delete', path: '/users/:id/roles/:roleId', module: M, summary: 'Revoke a role from a member',
  access: { permission: 'roles:assign' }, params: z.object({ id: uuid, roleId: uuid }),
  audit: { action: 'role.revoked', resourceType: 'user' },
  async handler(c) {
    const m = await loadMember(c, c.params.id);
    await revokeRole(c.trx, actor(c), m.membership_id, m.user_id, c.params.roleId);
    return { status: 204, auditResourceId: m.user_id };
  },
});

// ---- roles -------------------------------------------------------------------------------------------------

defineRoute({
  method: 'get', path: '/roles', module: M, summary: 'List system and custom roles', access: { permission: 'roles:read' }, response: obj,
  async handler(c) {
    const rows = await c.trx('roles').where((w) => w.whereNull('organization_id').orWhere({ organization_id: c.orgId() })).orderBy([{ column: 'is_system', order: 'desc' }, 'name']);
    return { data: rows.map((r) => rowToApi(r)) };
  },
});

defineRoute({
  method: 'get', path: '/roles/:id', module: M, summary: 'Get a role with its permissions', access: { permission: 'roles:read' },
  params: idParams, response: obj,
  async handler(c) {
    const role = await getRole(c.trx, c.orgId(), c.params.id);
    return { data: { ...rowToApi(role), permissions: (await rolePermissionKeys(c.trx, role.id)).sort() } };
  },
});

defineRoute({
  method: 'post', path: '/roles', module: M, summary: 'Create a custom role', access: { permission: 'roles:create' },
  body: z.object({
    key: z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9_]{2,40}$/), name: z.string().trim().min(2).max(80),
    description: z.string().max(300).default(''), permissions: z.array(z.string()).max(500).default([]),
  }),
  response: obj, audit: { action: 'role.created', resourceType: 'role' },
  async handler(c) {
    const valid = await c.trx('permissions').whereIn('key', c.body.permissions).select('key');
    if (valid.length !== new Set(c.body.permissions).size) throw new AppError('VALIDATION_FAILED', 'Unknown permission key', [{ field: 'permissions', issue: 'unknown' }]);
    await assertCanGrant(c.trx, c.auth!, c.body.permissions);
    const id = newId();
    try {
      await c.trx('roles').insert({
        id, organization_id: c.orgId(), key: c.body.key, name: c.body.name, description: c.body.description,
        is_system: false, created_by: c.auth!.userId, updated_by: c.auth!.userId,
      });
    } catch (e) { throw mapDbError(e); }
    if (c.body.permissions.length) {
      await c.trx('role_permissions').insert([...new Set(c.body.permissions)].map((permission_key) => ({ role_id: id, permission_key })));
    }
    return { status: 201, data: { id, ...c.body } };
  },
});

defineRoute({
  method: 'patch', path: '/roles/:id', module: M, summary: 'Update a custom role', access: { permission: 'roles:update' },
  params: idParams, body: z.object({ name: z.string().trim().min(2).max(80).optional(), description: z.string().max(300).optional() }),
  response: obj, audit: { action: 'role.updated', resourceType: 'role' },
  async handler(c) {
    const role = await getRole(c.trx, c.orgId(), c.params.id);
    if (role.is_system) throw new AppError('CONFLICT', 'System roles are immutable');
    await c.trx('roles').where({ id: role.id }).update({ ...c.body, updated_at: c.svc.now(), updated_by: c.auth!.userId, row_version: c.trx.raw('row_version + 1') });
    return { data: rowToApi(await c.trx('roles').where({ id: role.id }).first()) };
  },
});

defineRoute({
  method: 'delete', path: '/roles/:id', module: M, summary: 'Delete an unused custom role', access: { permission: 'roles:delete' },
  params: idParams, audit: { action: 'role.deleted', resourceType: 'role' },
  async handler(c) {
    const role = await getRole(c.trx, c.orgId(), c.params.id);
    if (role.is_system) throw new AppError('CONFLICT', 'System roles are immutable');
    const used = await c.trx('user_role_assignments').where({ role_id: role.id }).first();
    const grouped = await c.trx('group_roles').where({ role_id: role.id }).first();
    if (used || grouped) throw new AppError('CONFLICT', 'Role is still assigned');
    await c.trx('invitations').where({ role_id: role.id }).update({ role_id: null }); // keep invitation history, drop the reference
    try {
      await c.trx('roles').where({ id: role.id }).delete();
    } catch (e) {
      if ((e as { code?: string }).code === '23503') throw new AppError('CONFLICT', 'Role is referenced by access requests or reviews');
      throw e;
    }
    return { status: 204, auditResourceId: role.id };
  },
});

defineRoute({
  method: 'put', path: '/roles/:id/permissions', module: M, summary: 'Replace the permission set of a custom role',
  access: { permission: 'roles:update' }, params: idParams, body: z.object({ permissions: z.array(z.string()).max(500) }),
  response: obj, audit: { action: 'role.permissions_changed', resourceType: 'role' },
  async handler(c) {
    const role = await getRole(c.trx, c.orgId(), c.params.id);
    if (role.is_system) throw new AppError('CONFLICT', 'System roles are immutable');
    const keys = [...new Set(c.body.permissions)];
    const valid = await c.trx('permissions').whereIn('key', keys).select('key');
    if (valid.length !== keys.length) throw new AppError('VALIDATION_FAILED', 'Unknown permission key', [{ field: 'permissions', issue: 'unknown' }]);
    await assertCanGrant(c.trx, c.auth!, keys);
    const before = await rolePermissionKeys(c.trx, role.id);
    await c.trx('role_permissions').where({ role_id: role.id }).delete();
    if (keys.length) await c.trx('role_permissions').insert(keys.map((permission_key) => ({ role_id: role.id, permission_key })));
    const holders = await c.trx('user_role_assignments as ura').join('organization_memberships as m', 'm.id', 'ura.membership_id')
      .where('ura.role_id', role.id).select('m.user_id');
    const groupHolders = await c.trx('group_roles as gr').join('user_group_members as ugm', 'ugm.group_id', 'gr.group_id')
      .join('organization_memberships as m', 'm.id', 'ugm.membership_id').where('gr.role_id', role.id).select('m.user_id');
    await bumpPermissionVersion(c.trx, [...new Set([...holders, ...groupHolders].map((h) => h.user_id as string))]);
    await c.audit({ action: 'role.permissions_diff', resourceType: 'role', resourceId: role.id,
      metadata: { added: keys.filter((k) => !before.includes(k)), removed: before.filter((k) => !keys.includes(k)) } });
    return { data: { id: role.id, permissions: keys.sort() } };
  },
});

defineRoute({
  method: 'get', path: '/permissions', module: M, summary: 'Permission catalog', access: { permission: 'permissions:read' }, response: obj,
  async handler(c) {
    return { data: await c.trx('permissions').orderBy('key').select('key', 'resource', 'action', 'description', 'module') };
  },
});

// ---- groups ------------------------------------------------------------------------------------------------

crudResource({
  module: M, path: '/groups', table: 'user_groups', resource: 'groups',
  create: z.object({ name: z.string().trim().min(2).max(80), description: z.string().max(300).default('') }),
  list: { sortable: { name: 'user_groups.name', created_at: 'user_groups.created_at' }, defaultSort: 'name' },
  searchColumns: ['user_groups.name'],
});

defineRoute({
  method: 'post', path: '/groups/:id/members', module: M, summary: 'Add a member to a group', access: { permission: 'groups:update' },
  params: idParams, body: z.object({ userId: uuid }), response: obj, audit: { action: 'group.member_added', resourceType: 'group' },
  async handler(c) {
    const g = await c.trx('user_groups').where({ id: c.params.id, organization_id: c.orgId() }).first();
    if (!g) throw new AppError('NOT_FOUND', 'Group not found');
    const m = await membershipFor(c.trx, c.orgId(), c.body.userId);
    if (!m || m.status !== 'active') throw new AppError('NOT_FOUND', 'User not found');
    try {
      await c.trx('user_group_members').insert({ id: newId(), organization_id: c.orgId(), group_id: g.id, membership_id: m.id });
    } catch (e) { throw mapDbError(e); }
    await bumpPermissionVersion(c.trx, [c.body.userId]);
    return { status: 201, data: { groupId: g.id, userId: c.body.userId }, auditResourceId: g.id };
  },
});

defineRoute({
  method: 'delete', path: '/groups/:id/members/:userId', module: M, summary: 'Remove a member from a group',
  access: { permission: 'groups:update' }, params: z.object({ id: uuid, userId: uuid }),
  audit: { action: 'group.member_removed', resourceType: 'group' },
  async handler(c) {
    const m = await membershipFor(c.trx, c.orgId(), c.params.userId);
    if (!m) throw new AppError('NOT_FOUND', 'User not found');
    const n = await c.trx('user_group_members').where({ group_id: c.params.id, membership_id: m.id, organization_id: c.orgId() }).delete();
    if (!n) throw new AppError('NOT_FOUND', 'Membership not found');
    await bumpPermissionVersion(c.trx, [c.params.userId]);
    return { status: 204, auditResourceId: c.params.id };
  },
});

defineRoute({
  method: 'put', path: '/groups/:id/roles', module: M, summary: 'Set the roles granted via a group',
  access: { permission: 'roles:assign' }, params: idParams, body: z.object({ roleIds: z.array(uuid).max(50) }),
  response: obj, audit: { action: 'group.roles_changed', resourceType: 'group' },
  async handler(c) {
    const g = await c.trx('user_groups').where({ id: c.params.id, organization_id: c.orgId() }).first();
    if (!g) throw new AppError('NOT_FOUND', 'Group not found');
    for (const rid of c.body.roleIds) {
      const role = await getRole(c.trx, c.orgId(), rid);
      await assertCanGrant(c.trx, c.auth!, await rolePermissionKeys(c.trx, role.id));
    }
    await c.trx('group_roles').where({ group_id: g.id }).delete();
    if (c.body.roleIds.length) {
      await c.trx('group_roles').insert(c.body.roleIds.map((role_id) => ({ id: newId(), organization_id: c.orgId(), group_id: g.id, role_id })));
    }
    const members = await c.trx('user_group_members as ugm').join('organization_memberships as m', 'm.id', 'ugm.membership_id')
      .where('ugm.group_id', g.id).select('m.user_id');
    await bumpPermissionVersion(c.trx, members.map((x) => x.user_id as string));
    return { data: { id: g.id, roleIds: c.body.roleIds } };
  },
});

// ---- access requests ---------------------------------------------------------------------------------------

defineRoute({
  method: 'post', path: '/access-requests', module: M, summary: 'Request a role', access: { permission: 'access_requests:create' },
  body: z.object({ roleId: uuid, reason: z.string().trim().min(5).max(500) }), response: obj,
  audit: { action: 'access_request.created', resourceType: 'access_request' },
  async handler(c) {
    await getRole(c.trx, c.orgId(), c.body.roleId);
    const id = newId();
    await c.trx('access_requests').insert({ id, organization_id: c.orgId(), requester_id: c.auth!.userId, role_id: c.body.roleId, reason: c.body.reason });
    return { status: 201, data: { id, status: 'pending' } };
  },
});

defineRoute({
  method: 'get', path: '/access-requests', module: M, summary: 'List access requests (own, or all with approve permission)',
  access: { permission: 'access_requests:read' }, query: listQuerySchema, response: obj,
  async handler(c) {
    const qb = c.trx('access_requests').where({ organization_id: c.orgId() });
    if (!c.auth!.permissions.has('access_requests:approve')) qb.where({ requester_id: c.auth!.userId });
    const page = await paginate(qb, c.query as ListQuery, {
      sortable: { created_at: 'created_at', status: 'status' }, filterable: { status: 'status' }, defaultSort: '-created_at',
    });
    return { data: page.data.map((r) => rowToApi(r)), meta: page.meta };
  },
});

async function decide(c: HandlerCtx, requestId: string, decision: 'approved' | 'denied', note?: string) {
  const r = await c.trx('access_requests').where({ id: requestId, organization_id: c.orgId() }).forUpdate().first();
  if (!r) throw new AppError('NOT_FOUND', 'Access request not found');
  if (r.status !== 'pending') throw new AppError('CONFLICT', 'Access request already decided');
  if (r.requester_id === c.auth!.userId) throw new AppError('FORBIDDEN', 'You cannot decide your own request');
  if (decision === 'approved') {
    const role = await getRole(c.trx, c.orgId(), r.role_id);
    await assertCanGrant(c.trx, c.auth!, await rolePermissionKeys(c.trx, role.id));
    const m = await membershipFor(c.trx, c.orgId(), r.requester_id);
    if (!m) throw new AppError('NOT_FOUND', 'Requester is not a member');
    const exists = await c.trx('user_role_assignments').where({ membership_id: m.id, role_id: role.id, scope_type: 'organization' }).first();
    if (!exists) await grantRole(c.trx, actor(c), m.id, r.requester_id, role.id, `access request ${r.id}`);
  }
  await c.trx('access_requests').where({ id: r.id }).update({
    status: decision, decided_by: c.auth!.userId, decided_at: c.svc.now(), decision_note: note ?? null,
    updated_at: c.svc.now(), row_version: c.trx.raw('row_version + 1'),
  });
  return { status: 200, data: { id: r.id, status: decision }, auditResourceId: r.id };
}

for (const [verb, decision] of [['approve', 'approved'], ['deny', 'denied']] as const) {
  defineRoute({
    method: 'post', path: `/access-requests/:id/${verb}`, module: M, summary: `${verb} an access request`,
    access: { permission: 'access_requests:approve' }, params: idParams, body: z.object({ note: z.string().max(300).optional() }).default({}),
    response: obj, audit: { action: `access_request.${decision}`, resourceType: 'access_request' },
    handler: (c) => decide(c, c.params.id, decision, (c.body as { note?: string }).note),
  });
}

// ---- caller-facing + admin previews -------------------------------------------------------------------------

defineRoute({
  method: 'get', path: '/me/permissions', module: M, summary: 'Permissions and action map for the caller',
  access: 'authenticated', response: obj,
  async handler(c) {
    const map: Record<string, string[]> = {};
    for (const key of [...c.auth!.permissions].sort()) {
      const [res, act] = key.split(':') as [string, string];
      (map[res] ??= []).push(act);
    }
    return { data: { permissions: [...c.auth!.permissions].sort(), resources: map, note: 'UI hiding is never enforcement' } };
  },
});

defineRoute({
  method: 'get', path: '/me/menu', module: M, summary: 'Navigation menu and sub-menus for the caller',
  access: 'authenticated', response: obj,
  async handler(c) {
    const flags: Record<string, boolean> = {};
    for (const key of menuFlagKeys()) {
      flags[key] = await isFlagEnabled(c.trx, key, { organizationId: c.orgId(), userId: c.auth!.userId });
    }
    const menu = buildMenu({ permissions: c.auth!.permissions, isPlatformAdmin: c.auth!.isPlatformAdmin, flags });
    return { data: { menu, note: 'UI hiding is never enforcement' } };
  },
});

defineRoute({
  method: 'get', path: '/iam/permission-matrix', module: M, summary: 'Role × permission matrix', access: { permission: 'iam:read' }, response: obj,
  async handler(c) {
    const roles = await c.trx('roles').where((w) => w.whereNull('organization_id').orWhere({ organization_id: c.orgId() })).orderBy('name');
    const rp = await c.trx('role_permissions').whereIn('role_id', roles.map((r) => r.id)).select('role_id', 'permission_key');
    const perms = await c.trx('permissions').orderBy('key').select('key');
    return {
      data: {
        permissions: perms.map((p) => p.key),
        roles: roles.map((r) => ({ id: r.id, key: r.key, name: r.name, isSystem: r.is_system, permissions: rp.filter((x) => x.role_id === r.id).map((x) => x.permission_key).sort() })),
      },
    };
  },
});

defineRoute({
  method: 'get', path: '/iam/users/:id/effective-access', module: M, summary: 'Effective access preview for a member',
  access: { permission: 'iam:read' }, params: idParams, response: obj,
  async handler(c) {
    const m = await loadMember(c, c.params.id);
    const direct = await c.trx('user_role_assignments as ura').join('roles as r', 'r.id', 'ura.role_id')
      .where('ura.membership_id', m.membership_id).select('r.id', 'r.key', 'r.name', 'ura.scope_type', 'ura.scope_id');
    const viaGroups = await c.trx('user_group_members as ugm').join('group_roles as gr', 'gr.group_id', 'ugm.group_id')
      .join('roles as r', 'r.id', 'gr.role_id').join('user_groups as g', 'g.id', 'ugm.group_id')
      .where('ugm.membership_id', m.membership_id).select('r.id', 'r.key', 'r.name', 'g.name as group_name');
    const orgDirect = direct.filter((d) => d.scope_type === 'organization').map((d) => d.id as string);
    const roleIds = [...new Set([...orgDirect, ...viaGroups.map((v) => v.id as string)])];
    const perms = roleIds.length
      ? await c.trx('role_permissions').whereIn('role_id', roleIds).distinct('permission_key')
      : [];
    return { data: { userId: m.user_id, directRoles: direct, groupRoles: viaGroups, permissions: perms.map((p) => p.permission_key).sort() } };
  },
});

defineRoute({
  method: 'get', path: '/iam/access-history', module: M, summary: 'Append-only access change history',
  access: { permission: 'iam:read' }, query: listQuerySchema, response: obj,
  async handler(c) {
    const page = await paginate(c.trx('access_history').where({ organization_id: c.orgId() }), c.query as ListQuery, {
      sortable: { occurred_at: 'occurred_at' }, defaultSort: '-occurred_at',
    });
    return { data: page.data.map((r) => rowToApi(r)), meta: page.meta };
  },
});

// ---- access reviews (F-190) --------------------------------------------------------------------------------

defineRoute({
  method: 'post', path: '/iam/access-reviews', module: M, summary: 'Start an access review campaign',
  access: { permission: 'iam:review' }, body: z.object({ name: z.string().trim().min(2).max(120), dueAt: z.string().datetime().optional() }),
  response: obj, audit: { action: 'access_review.started', resourceType: 'access_review' },
  async handler(c) {
    const id = newId();
    await c.trx('access_reviews').insert({ id, organization_id: c.orgId(), name: c.body.name, due_at: c.body.dueAt ?? null, created_by: c.auth!.userId });
    const assignments = await c.trx('user_role_assignments as ura').join('organization_memberships as m', 'm.id', 'ura.membership_id')
      .where({ 'ura.organization_id': c.orgId(), 'm.status': 'active', 'ura.scope_type': 'organization' })
      .select('ura.id as assignment_id', 'm.user_id', 'ura.role_id');
    if (assignments.length) {
      await c.trx('access_review_items').insert(assignments.map((a) => ({
        id: newId(), organization_id: c.orgId(), review_id: id, assignment_id: a.assignment_id, subject_user_id: a.user_id, role_id: a.role_id,
      })));
    }
    return { status: 201, data: { id, items: assignments.length } };
  },
});

defineRoute({
  method: 'get', path: '/iam/access-reviews/:id', module: M, summary: 'Access review with items', access: { permission: 'iam:review' },
  params: idParams, response: obj,
  async handler(c) {
    const r = await c.trx('access_reviews').where({ id: c.params.id, organization_id: c.orgId() }).first();
    if (!r) throw new AppError('NOT_FOUND', 'Review not found');
    const items = await c.trx('access_review_items').where({ review_id: r.id }).orderBy('id');
    return { data: { ...rowToApi(r), items: items.map((i) => rowToApi(i)) } };
  },
});

defineRoute({
  method: 'post', path: '/iam/access-reviews/:id/items/:itemId/decision', module: M, summary: 'Keep or revoke a reviewed assignment',
  access: { permission: 'iam:review' }, params: z.object({ id: uuid, itemId: uuid }), body: z.object({ decision: z.enum(['keep', 'revoke']) }),
  response: obj, audit: { action: 'access_review.decided', resourceType: 'access_review' },
  async handler(c) {
    const item = await c.trx('access_review_items').where({ id: c.params.itemId, review_id: c.params.id, organization_id: c.orgId() }).forUpdate().first();
    if (!item) throw new AppError('NOT_FOUND', 'Review item not found');
    if (item.decision !== 'pending') throw new AppError('CONFLICT', 'Item already decided');
    if (c.body.decision === 'revoke') {
      const m = await membershipFor(c.trx, c.orgId(), item.subject_user_id);
      if (m) {
        try { await revokeRole(c.trx, actor(c), m.id, item.subject_user_id, item.role_id, `access review ${c.params.id}`); }
        catch (e) { if (!(e instanceof AppError && e.code === 'NOT_FOUND')) throw e; }
      }
    }
    await c.trx('access_review_items').where({ id: item.id }).update({ decision: c.body.decision, decided_by: c.auth!.userId, decided_at: c.svc.now() });
    const pending = await c.trx('access_review_items').where({ review_id: c.params.id, decision: 'pending' }).first();
    if (!pending) await c.trx('access_reviews').where({ id: c.params.id }).update({ status: 'completed', completed_at: c.svc.now() });
    return { status: 200, data: { itemId: item.id, decision: c.body.decision }, auditResourceId: c.params.id };
  },
});

// ---- permission change approvals (F-191) ---------------------------------------------------------------------

defineRoute({
  method: 'get', path: '/iam/permission-change-requests', module: M, summary: 'Pending privileged-change requests',
  access: { permission: 'iam:approve' }, query: listQuerySchema, response: obj,
  async handler(c) {
    const page = await paginate(c.trx('permission_change_requests').where({ organization_id: c.orgId() }), c.query as ListQuery, {
      sortable: { created_at: 'created_at' }, filterable: { status: 'status' }, defaultSort: '-created_at',
    });
    return { data: page.data.map((r) => rowToApi(r)), meta: page.meta };
  },
});

for (const [verb, status] of [['approve', 'approved'], ['reject', 'rejected']] as const) {
  defineRoute({
    method: 'post', path: `/iam/permission-change-requests/:id/${verb}`, module: M, summary: `${verb} a privileged change`,
    access: { permission: 'iam:approve' }, params: idParams, response: obj,
    audit: { action: `permission_change.${status}`, resourceType: 'permission_change_request' },
    async handler(c) {
      const r = await c.trx('permission_change_requests').where({ id: c.params.id, organization_id: c.orgId() }).forUpdate().first();
      if (!r) throw new AppError('NOT_FOUND', 'Request not found');
      if (r.status !== 'pending') throw new AppError('CONFLICT', 'Request already decided');
      if (r.requested_by === c.auth!.userId) throw new AppError('FORBIDDEN', 'You cannot approve your own change');
      let finalStatus: string = status;
      if (status === 'approved' && r.change_type === 'grant_role') {
        const p = r.payload as { membershipId: string; userId: string; roleId: string; reason?: string };
        const role = await getRole(c.trx, c.orgId(), p.roleId);
        await assertCanGrant(c.trx, c.auth!, await rolePermissionKeys(c.trx, role.id));
        await grantRole(c.trx, actor(c), p.membershipId, p.userId, p.roleId, p.reason ?? 'approved change');
        finalStatus = 'applied';
      }
      await c.trx('permission_change_requests').where({ id: r.id }).update({ status: finalStatus, decided_by: c.auth!.userId, decided_at: c.svc.now() });
      return { status: 200, data: { id: r.id, status: finalStatus }, auditResourceId: r.id };
    },
  });
}

void [randomToken, sha256, logAccess, revokeAllSessions, recordSecurityEvent];
