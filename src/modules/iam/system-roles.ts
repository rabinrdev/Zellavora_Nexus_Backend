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
    for (const key of all) {
      const [resource, action] = key.split(':') as [string, string];
      await t('permissions').insert({ key, resource, action }).onConflict('key').merge(['resource', 'action']);
    }
    for (const role of SYSTEM_ROLES) {
      const id = SYSTEM_ROLE_IDS[role.key];
      const exists = await t('roles').where({ id }).first();
      if (exists) {
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
