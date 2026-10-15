import { describe, it, expect } from 'vitest';
import { buildMenu, menuFlagKeys, MENU, type MenuNode } from '../src/modules/iam/menu.js';
import { MODULE_FLAGS } from '../src/platform/flags.js';
import { SYSTEM_ROLE_IDS, permissionsForRole } from '../src/modules/iam/system-roles.js';

const flat = (nodes: MenuNode[]): string[] => nodes.flatMap((n) => [n.key, ...flat(n.children)]);
const viewer = (permissions: string[], over: { isPlatformAdmin?: boolean; flags?: Record<string, boolean> } = {}) => ({
  permissions: new Set(permissions), isPlatformAdmin: over.isPlatformAdmin ?? false, flags: over.flags ?? {},
});

describe('menu registry', () => {
  it('only references known module flags', () => {
    for (const k of menuFlagKeys()) expect(MODULE_FLAGS as readonly string[]).toContain(k);
  });

  it('has unique keys', () => {
    const keys = flat(buildMenu(viewer([], { isPlatformAdmin: true, flags: Object.fromEntries(MODULE_FLAGS.map((f) => [f, true])) }), MENU));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('returns nothing for a caller without permissions', () => {
    expect(buildMenu(viewer([]))).toEqual([]);
  });

  it('shows only permitted sub-menus and drops empty groups', () => {
    const menu = buildMenu(viewer(['dashboard:read', 'users:read', 'roles:read']));
    expect(flat(menu)).toEqual(['dashboard', 'people', 'people.users', 'people.roles']);
    expect(menu.find((m) => m.key === 'people')?.path).toBeNull();
  });

  it('hides module entries when the flag is off, shows them when on', () => {
    const perms = ['projects:read'];
    expect(flat(buildMenu(viewer(perms, { flags: { 'module.projects': false } })))).toEqual([]);
    expect(flat(buildMenu(viewer(perms, { flags: { 'module.projects': true } })))).toEqual(['work', 'work.projects']);
  });

  it('supports nested groups (any-of permission on leaves)', () => {
    const menu = buildMenu(viewer(['timesheets:review'], { flags: { 'module.timesheets': true } }));
    expect(flat(menu)).toEqual(['work', 'work.timesheets', 'work.timesheets.team', 'work.timesheets.billable']);
  });

  it('shows the platform group to platform admins only', () => {
    expect(flat(buildMenu(viewer([])))).not.toContain('platform');
    const admin = flat(buildMenu(viewer([], { isPlatformAdmin: true })));
    expect(admin).toContain('platform.health');
    expect(admin).not.toContain('platform.alerts'); // module.platform_ops is off
  });

  it('gives the org admin role every non-platform tenant entry and the viewer a read-only subset', () => {
    const all = MENU.flatMap(function walk(m): string[] { return [...(m.anyPermission ?? []), ...(m.children ?? []).flatMap(walk)]; });
    const flags = Object.fromEntries(MODULE_FLAGS.map((f) => [f, true]));
    const admin = permissionsForRole('org_admin', all);
    const viewerRole = permissionsForRole('viewer', all);
    expect(SYSTEM_ROLE_IDS.org_admin).toBeTruthy();
    const adminKeys = flat(buildMenu(viewer(admin, { flags })));
    const viewerKeys = flat(buildMenu(viewer(viewerRole, { flags })));
    expect(adminKeys.length).toBeGreaterThan(viewerKeys.length);
    expect(viewerKeys).not.toContain('people.roles');
  });
});
