import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { getCtx, createActor, type Actor, type TestCtx } from '../helpers/app.js';
import { addMember, createEmptyRole } from '../helpers/members.js';
import { routeRegistry, permissionOf, type AnyRoute } from '../../src/platform/http/route.js';
import { buildOpenApi } from '../../src/platform/openapi/buildSpec.js';

let ctx: TestCtx;
let adminA: Actor;
let adminB: Actor;
let nobody: Actor;

const fill = (r: AnyRoute) =>
  `/api/v1${r.path.replace(/:(\w+)/g, (_m, p: string) => (/id$/i.test(p) ? randomUUID() : 'x'.repeat(40)))}`;

beforeAll(async () => {
  ctx = await getCtx();
  adminA = await createActor(ctx);
  adminB = await createActor(ctx);
  nobody = await addMember(ctx, adminA, await createEmptyRole(ctx, adminA));
});
afterAll(async () => {
  await ctx.close();
});

const call = (r: AnyRoute, headers: Record<string, string> = {}) => {
  const t = ctx.api[r.method](fill(r)).set(headers);
  return ['get', 'delete'].includes(r.method) ? t : t.send({});
};

describe('route registry (F-155 / deny-by-default)', () => {
  it('registers routes and every route declares an access mode', () => {
    expect(routeRegistry.length).toBeGreaterThan(80);
    for (const r of routeRegistry) expect(r.access, `${r.method} ${r.path}`).toBeTruthy();
  });

  it('every non-public route returns 401 without credentials', async () => {
    for (const r of routeRegistry.filter((x) => x.access !== 'public')) {
      const res = await call(r);
      expect(res.status, `${r.method.toUpperCase()} ${r.path}`).toBe(401);
    }
  });

  it('a member with no permissions gets 403 (never 2xx) on every permission-protected route', async () => {
    for (const r of routeRegistry.filter((x) => permissionOf(x) || x.access === 'platformAdmin')) {
      const res = await call(r, nobody.auth);
      expect(res.status, `${r.method.toUpperCase()} ${r.path}`).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    }
  });

  it('an organization admin never gets a 5xx or a 2xx for unknown resource ids', async () => {
    for (const r of routeRegistry.filter((x) => x.access !== 'public' && x.access !== 'platformAdmin' && /:\w*id/i.test(x.path))) {
      const res = await call(r, adminA.auth);
      expect(res.status, `${r.method.toUpperCase()} ${r.path}`).toBeLessThan(500);
      expect([401, 403, 404, 409, 412, 422], `${r.method.toUpperCase()} ${r.path} -> ${res.status}`).toContain(res.status);
    }
  });

  it('every route has an operationId and the document builds', () => {
    for (const r of routeRegistry) expect(r.operationId, `${r.method} ${r.path}`).toBeTruthy();
    const doc = buildOpenApi({ version: 'test', audience: 'full' });
    expect(doc.openapi).toBe('3.1.0');
    expect(Object.keys(doc.paths ?? {}).length).toBeGreaterThan(60);
  });
});

describe('tenant isolation with real resources', () => {
  it('other-tenant ids return 404 and client-supplied organization ids are ignored', async () => {
    const dep = await ctx.api.post('/api/v1/departments').set(adminB.auth).send({ name: `Dept ${randomUUID().slice(0, 6)}` });
    expect(dep.status).toBe(201);
    const id = dep.body.data.id;
    expect((await ctx.api.get(`/api/v1/departments/${id}`).set(adminA.auth)).status).toBe(404);
    expect((await ctx.api.patch(`/api/v1/departments/${id}`).set(adminA.auth).send({ name: 'Hijack', rowVersion: 1 })).status).toBe(404);
    expect((await ctx.api.delete(`/api/v1/departments/${id}`).set(adminA.auth)).status).toBe(404);

    const forged = await ctx.api.post('/api/v1/departments').set(adminA.auth)
      .set('X-Organization-Id', adminB.organizationId!)
      .send({ name: `Forged ${randomUUID().slice(0, 6)}`, organizationId: adminB.organizationId, organization_id: adminB.organizationId });
    expect(forged.status).toBe(201);
    expect(forged.body.data.organizationId).toBe(adminA.organizationId);

    const listB = await ctx.api.get('/api/v1/departments').set(adminB.auth);
    expect(listB.body.data.find((d: { id: string }) => d.id === forged.body.data.id)).toBeUndefined();
  });

  it('roles, groups, API keys and invitations of another tenant are invisible', async () => {
    const role = await ctx.api.post('/api/v1/roles').set(adminB.auth).send({ key: `r_${randomUUID().slice(0, 6)}`, name: 'Role B', permissions: ['users:read'] });
    expect((await ctx.api.get(`/api/v1/roles/${role.body.data.id}`).set(adminA.auth)).status).toBe(404);
    expect((await ctx.api.put(`/api/v1/roles/${role.body.data.id}/permissions`).set(adminA.auth).send({ permissions: [] })).status).toBe(404);
    const grp = await ctx.api.post('/api/v1/groups').set(adminB.auth).send({ name: `Group ${randomUUID().slice(0, 6)}` });
    expect((await ctx.api.get(`/api/v1/groups/${grp.body.data.id}`).set(adminA.auth)).status).toBe(404);
    const key = await ctx.api.post('/api/v1/api-keys').set(adminB.auth).send({ name: 'key-b', scopes: ['users:read'] });
    expect((await ctx.api.post(`/api/v1/api-keys/${key.body.data.id}/revoke`).set(adminA.auth)).status).toBe(404);
  });

  it('platform-only routes are not reachable by tenant admins', async () => {
    const res = await ctx.api.get('/api/v1/platform/health').set(adminA.auth);
    expect(res.status).toBe(403);
  });
});
