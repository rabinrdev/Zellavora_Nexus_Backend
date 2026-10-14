import { AppError } from '../../platform/errors.js';
import { newId } from '../../platform/crypto.js';
import { bumpPermissionVersion } from '../../platform/authz.js';
import type { AuthContext } from '../../platform/types.js';
import type { Trx } from '../../platform/scope.js';
import { SYSTEM_ROLE_IDS } from './system-roles.js';

export async function getRole(trx: Trx, organizationId: string, roleId: string) {
  const role = await trx('roles').where({ id: roleId }).where((w) => w.whereNull('organization_id').orWhere({ organization_id: organizationId })).first();
  if (!role) throw new AppError('NOT_FOUND', 'Role not found');
  return role;
}

export async function rolePermissionKeys(trx: Trx, roleId: string): Promise<string[]> {
  return (await trx('role_permissions').where({ role_id: roleId }).select('permission_key')).map((r) => r.permission_key as string);
}

/** A grantor may never hand out permissions they do not hold themselves (no privilege escalation). */
export async function assertCanGrant(trx: Trx, auth: AuthContext, permissionKeys: string[]): Promise<void> {
  const missing = permissionKeys.filter((k) => !auth.permissions.has(k));
  if (missing.length > 0) {
    throw new AppError('FORBIDDEN', 'You cannot grant permissions you do not hold', missing.slice(0, 10).map((k) => ({ field: 'permissions', issue: k })));
  }
  void trx;
}

export async function activeAdminCount(trx: Trx, organizationId: string, excludingMembershipId?: string): Promise<number> {
  const q = trx('user_role_assignments as ura')
    .join('organization_memberships as m', 'm.id', 'ura.membership_id')
    .where({ 'ura.organization_id': organizationId, 'ura.role_id': SYSTEM_ROLE_IDS.org_admin, 'ura.scope_type': 'organization', 'm.status': 'active' })
    .countDistinct({ c: 'm.id' });
  if (excludingMembershipId) q.whereNot('m.id', excludingMembershipId);
  const row = (await q.first()) as { c: string | number } | undefined;
  return Number(row?.c ?? 0);
}

export interface Actor { userId: string; organizationId: string }

export async function logAccess(trx: Trx, actor: Actor, subjectUserId: string, roleId: string | null, change: string, reason?: string) {
  await trx('access_history').insert({
    id: newId(), organization_id: actor.organizationId, actor_id: actor.userId, subject_user_id: subjectUserId,
    role_id: roleId, change, reason: reason ?? null,
  });
}

export async function membershipFor(trx: Trx, organizationId: string, userId: string) {
  return trx('organization_memberships').where({ organization_id: organizationId, user_id: userId }).first();
}

export async function grantRole(trx: Trx, actor: Actor, membershipId: string, userId: string, roleId: string, reason?: string, scope?: { type: string; id: string }) {
  try {
    await trx('user_role_assignments').insert({
      id: newId(), organization_id: actor.organizationId, membership_id: membershipId, role_id: roleId,
      scope_type: scope?.type ?? 'organization', scope_id: scope?.id ?? null, created_by: actor.userId,
    });
  } catch (e) {
    if ((e as { code?: string }).code === '23505') throw new AppError('CONFLICT', 'Role is already assigned');
    throw e;
  }
  await logAccess(trx, actor, userId, roleId, 'granted', reason);
  await bumpPermissionVersion(trx, [userId]);
}

export async function revokeRole(trx: Trx, actor: Actor, membershipId: string, userId: string, roleId: string, reason?: string) {
  if (roleId === SYSTEM_ROLE_IDS.org_admin) {
    const remaining = await activeAdminCount(trx, actor.organizationId, membershipId);
    if (remaining === 0) throw new AppError('CONFLICT', 'The last Organization Admin cannot be removed or demoted');
  }
  const n = await trx('user_role_assignments')
    .where({ organization_id: actor.organizationId, membership_id: membershipId, role_id: roleId, scope_type: 'organization' }).delete();
  if (n === 0) throw new AppError('NOT_FOUND', 'Role assignment not found');
  await logAccess(trx, actor, userId, roleId, 'revoked', reason);
  await bumpPermissionVersion(trx, [userId]);
}

/** Roles whose permission set is privileged: changes need a second admin's approval when enabled in org settings. */
export async function approvalsRequired(trx: Trx, organizationId: string): Promise<boolean> {
  const s = await trx('organization_settings').where({ organization_id: organizationId, key: 'iam.permission_change_approval' }).first();
  return s?.value === true;
}
