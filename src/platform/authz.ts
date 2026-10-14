import type { Trx } from './scope.js';

/**
 * Effective organization-level permissions:
 *   direct org-scoped role assignments  ∪  roles granted via group membership.
 * Scoped (team/project) assignments are resolved separately by `scopedPermissions`.
 * There is no explicit deny; resolution order is documented in docs/SECURITY.md.
 */
export async function loadOrgPermissions(trx: Trx, membershipId: string): Promise<Set<string>> {
  const rows = await trx.raw<{ rows: { permission_key: string }[] }>(
    `SELECT rp.permission_key
       FROM user_role_assignments ura
       JOIN role_permissions rp ON rp.role_id = ura.role_id
      WHERE ura.membership_id = ? AND ura.scope_type = 'organization'
     UNION
     SELECT rp.permission_key
       FROM user_group_members ugm
       JOIN group_roles gr ON gr.group_id = ugm.group_id
       JOIN role_permissions rp ON rp.role_id = gr.role_id
      WHERE ugm.membership_id = ?`,
    [membershipId, membershipId],
  );
  return new Set(rows.rows.map((r) => r.permission_key));
}

export async function scopedPermissions(
  trx: Trx,
  membershipId: string,
  scopeType: string,
  scopeId: string,
): Promise<Set<string>> {
  const rows = await trx('user_role_assignments as ura')
    .join('role_permissions as rp', 'rp.role_id', 'ura.role_id')
    .where({ 'ura.membership_id': membershipId, 'ura.scope_type': scopeType, 'ura.scope_id': scopeId })
    .select('rp.permission_key');
  return new Set(rows.map((r) => r.permission_key as string));
}

/** Bumps permission_version so every outstanding access token for these users is rejected at once. */
export async function bumpPermissionVersion(trx: Trx, userIds: string[]): Promise<void> {
  if (userIds.length === 0) return;
  await trx('users').whereIn('id', userIds).increment('permission_version', 1);
}

const TTL_MS = 15_000;
const cache = new Map<string, { at: number; perms: Set<string> }>();

export async function cachedOrgPermissions(
  trx: Trx,
  membershipId: string,
  permissionVersion: number,
): Promise<Set<string>> {
  const key = `${membershipId}:${permissionVersion}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.perms;
  const perms = await loadOrgPermissions(trx, membershipId);
  cache.set(key, { at: Date.now(), perms });
  if (cache.size > 5000) cache.clear();
  return perms;
}

export function clearPermissionCache(): void {
  cache.clear();
}
