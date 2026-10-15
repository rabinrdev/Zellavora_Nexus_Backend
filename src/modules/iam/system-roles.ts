import type { Knex } from 'knex';
import { routeRegistry, permissionOf } from '../../platform/http/route.js';
import { withPlatformScope } from '../../platform/scope.js';

/** Fixed IDs so seeds, tests and docs can refer to system roles deterministically. */
export const SYSTEM_ROLE_IDS = {
  org_admin: '00000000-0000-7000-8000-000000000001',
  manager: '00000000-0000-7000-8000-000000000002',
  member: '00000000-0000-7000-8000-000000000003',
  viewer: '00000000-0000-7000-8000-000000000004',
} as const;
export type SystemRoleKey = keyof typeof SYSTEM_ROLE_IDS;

/** Extra permission keys not tied to a single route (declared so they appear in the catalog). */
export const EXTRA_PERMISSIONS = ['reports:export', 'files:preview', 'projects:manage_all', 'approvals:manage', 'timesheets:manage_all', 'documents:manage_all'];

/** Resources only admins may touch: managers/members/viewers never get these by default. */
const ADMIN_RESOURCES = new Set([
  'roles', 'permissions', 'security', 'api_keys', 'settings', 'audit', 'retention', 'deletion', 'privacy',
  'organization', 'groups', 'iam', 'integrations', 'webhooks', 'support_access', 'portal_accounts', 'tax_configs', 'billing', 'platform', 'feature_flags', 'imports', 'invitations', 'users',
]);

export function permissionsForRole(role: SystemRoleKey, all: string[]): string[] {
  const tenant = all.filter((k) => !k.startsWith('platform:'));
  const split = (k: string) => k.split(':') as [string, string];
  switch (role) {
    case 'org_admin':
      return tenant;
    case 'manager':
      return tenant.filter((k) => {
        const [res, act] = split(k);
        if (['approvals:manage', 'timesheets:manage_all', 'documents:manage_all'].includes(k)) return false; // participants-only / team-scoped visibility
        if (ADMIN_RESOURCES.has(res)) return act === 'read' && ['users', 'organization'].includes(res);
        return !['delete', 'purge'].includes(act) || res === 'tasks';
      });
    case 'member':
      return tenant.filter((k) => {
        const [res, act] = split(k);
        if (ADMIN_RESOURCES.has(res)) return false;
        return ['read', 'create', 'update', 'upload', 'comment'].includes(act);
      });
    case 'viewer':
      return tenant.filter((k) => {
        const [res, act] = split(k);
        if (res === 'access_requests' && ['create', 'read'].includes(act)) return true; // anyone may ask for more access
        return act === 'read' && !ADMIN_RESOURCES.has(res);
      });
  }
}

const SYSTEM_ROLES: { key: SystemRoleKey; name: string; description: string; privileged: boolean }[] = [
  { key: 'org_admin', name: 'Organization Admin', description: 'Full control of the organization', privileged: true },
  { key: 'manager', name: 'Manager', description: 'Manages teams and operational work', privileged: false },
  { key: 'member', name: 'Member', description: 'Standard contributor', privileged: false },
  { key: 'viewer', name: 'Viewer', description: 'Read-only access', privileged: false },
];

/** Permission catalog sync (from route metadata) + system role permission sets. Idempotent; run at boot. */
export async function syncCatalogAndSystemRoles(db: Knex): Promise<string[]> {
  const keys = new Set<string>(EXTRA_PERMISSIONS);
  for (const r of routeRegistry) {
    const p = permissionOf(r);
    if (p) keys.add(p);
  }
  const all = [...keys].sort();
  await withPlatformScope(db, 'catalog-sync', async (t) => {
    // Cold starts on serverless must stay cheap: read the current state (3 queries) and write only when it differs.
    const roleIds = SYSTEM_ROLES.map((r) => SYSTEM_ROLE_IDS[r.key]);
    const havePerms = new Set((await t('permissions').select('key')).map((r: { key: string }) => r.key));
    const haveRoles: { id: string; name: string; description: string | null; privileged: boolean }[] =
      await t('roles').whereIn('id', roleIds).select('id', 'name', 'description', 'privileged');
    const haveRp: { role_id: string; permission_key: string }[] =
      await t('role_permissions').whereIn('role_id', roleIds).select('role_id', 'permission_key');
    const rpByRole = new Map<string, Set<string>>();
    for (const r of haveRp) (rpByRole.get(r.role_id) ?? rpByRole.set(r.role_id, new Set()).get(r.role_id)!).add(r.permission_key);

    const permsInSync = all.every((k) => havePerms.has(k));
    const staleRoles = SYSTEM_ROLES.filter((role) => {
      const id = SYSTEM_ROLE_IDS[role.key];
      const row = haveRoles.find((r) => r.id === id);
      if (!row || row.name !== role.name || (row.description ?? null) !== (role.description ?? null) || row.privileged !== role.privileged) return true;
      const want = permissionsForRole(role.key, all);
      const have = rpByRole.get(id) ?? new Set<string>();
      return have.size !== want.length || want.some((k) => !have.has(k));
    });
    if (permsInSync && staleRoles.length === 0) return;

    if (!permsInSync) {
      const rows = all.filter((k) => !havePerms.has(k)).map((key) => {
        const [resource, action] = key.split(':') as [string, string];
        return { key, resource, action };
      });
      for (let i = 0; i < rows.length; i += 500) {
        await t('permissions').insert(rows.slice(i, i + 500)).onConflict('key').merge(['resource', 'action']);
      }
    }
    for (const role of staleRoles) {
      const id = SYSTEM_ROLE_IDS[role.key];
      if (haveRoles.some((r) => r.id === id)) {
        await t('roles').where({ id }).update({ name: role.name, description: role.description, privileged: role.privileged });
      } else {
        await t('roles').insert({
          id, organization_id: null, key: role.key, name: role.name, description: role.description,
          is_system: true, privileged: role.privileged,
        });
      }
      const want = permissionsForRole(role.key, all);
      await t('role_permissions').where({ role_id: id }).whereNotIn('permission_key', want).delete();
      if (want.length) {
        await t('role_permissions')
          .insert(want.map((permission_key) => ({ role_id: id, permission_key })))
          .onConflict(['role_id', 'permission_key'])
          .ignore();
      }
    }
  });
  return all;
}
