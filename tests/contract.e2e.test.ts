import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import AjvModule from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { randomUUID } from 'node:crypto';
import { getCtx, createActor, createPlatformAdmin, type Actor, type TestCtx } from './helpers/app.js';
import { buildOpenApi } from '../src/platform/openapi/buildSpec.js';
import { routeRegistry, type AnyRoute } from '../src/platform/http/route.js';

/**
 * F-174: live responses must match the generated OpenAPI contract (paths, methods, declared statuses, envelope and
 * the documented JSON schema). Every parameterless GET is exercised, plus the documented error shapes.
 */
let ctx: TestCtx;
let admin: Actor;
let platform: Actor;
const doc = buildOpenApi({ version: 'contract', audience: 'full' }) as unknown as {
  paths: Record<string, Record<string, Op>>;
  components: { schemas: Record<string, unknown> };
};

type Op = { operationId: string; responses: Record<string, { $ref?: string; content?: Record<string, { schema?: unknown }> }>; security?: unknown[] };

// CJS default-export interop (NodeNext)
const Ajv2020 = ((AjvModule as unknown as { default?: typeof AjvModule }).default ?? AjvModule) as unknown as new (o: object) => import('ajv').default;
const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ?? addFormatsModule) as (a: unknown) => void;
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(doc, 'spec');

const esc = (s: string) => s.replace(/~/g, '~0').replace(/\//g, '~1');
const opFor = (r: AnyRoute): Op | undefined => doc.paths[`/api/v1${r.path.replace(/:(\w+)/g, '{$1}')}`]?.[r.method];
const declared = (o: Op, status: number) => String(status) in o.responses;

function validate(r: AnyRoute, status: number, body: unknown, label: string) {
  const o = opFor(r)!;
  const resp = o.responses[String(status)]!;
  let ref: string;
  if (resp.$ref) ref = status === 422 ? 'spec#/components/schemas/ValidationErrorResponse' : 'spec#/components/schemas/ErrorResponse';
  else ref = `spec#/paths/${esc(`/api/v1${r.path.replace(/:(\w+)/g, '{$1}')}`)}/${r.method}/responses/${status}/content/application~1json/schema`;
  const v = ajv.getSchema(ref);
  expect(v, `${label}: no schema at ${ref}`).toBeTruthy();
  const ok = v!(body);
  expect(ok, `${label} (${status}) does not match ${ref}: ${JSON.stringify(v!.errors?.slice(0, 3))} body=${JSON.stringify(body).slice(0, 400)}`).toBe(true);
}

beforeAll(async () => {
  ctx = await getCtx();
  admin = await createActor(ctx);
  platform = await createPlatformAdmin(ctx);
});
afterAll(async () => {
  await ctx.close();
});

const fill = (r: AnyRoute, id: string = randomUUID()) =>
  `/api/v1${r.path.replace(/:(\w+)/g, (_m, p: string) => (/id$/i.test(p) ? id : 'x'.repeat(24)))}`;

describe('OpenAPI contract', () => {
  it('every registered route is in the full spec with its operationId', () => {
    for (const r of routeRegistry) expect(opFor(r)?.operationId, `${r.method} ${r.path}`).toBe(r.operationId);
  });

  it('every parameterless GET returns a documented status and a body that matches its schema', async () => {
    const gets = routeRegistry.filter((r) => r.method === 'get' && !r.path.includes(':') && !r.binary && r.access !== 'public');
    expect(gets.length).toBeGreaterThan(40);
    const failures: string[] = [];
    for (const r of gets) {
      const actor = r.access === 'platformAdmin' ? platform : admin;
      const res = await ctx.api.get(fill(r)).set(actor.auth);
      const label = `GET ${r.path} [${r.operationId}]`;
      expect(res.status, label).toBeLessThan(500);
      if (!declared(opFor(r)!, res.status)) failures.push(`${label}: status ${res.status} is not documented`);
      else if (res.status === 200 || res.status >= 400) {
        try {
          validate(r, res.status, res.body, label);
        } catch (e) {
          failures.push((e as Error).message.slice(0, 600));
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('documented 401 (no credentials) matches ErrorResponse on every protected operation', async () => {
    const protectedRoutes = routeRegistry.filter((r) => r.access !== 'public');
    for (const r of protectedRoutes) {
      const res = await ctx.api[r.method](fill(r)).send({});
      const label = `${r.method.toUpperCase()} ${r.path}`;
      expect(res.status, label).toBe(401);
      expect(declared(opFor(r)!, 401), `${label}: 401 not documented`).toBe(true);
      validate(r, 401, res.body, label);
    }
  });

  it('documented 422 (malformed id) matches ValidationErrorResponse', async () => {
    const withParams = routeRegistry.filter((r) => r.params && r.access !== 'public' && r.access !== 'platformAdmin' && /:\w*id\b/i.test(r.path));
    expect(withParams.length).toBeGreaterThan(50);
    const failures: string[] = [];
    for (const r of withParams) {
      const res = await ctx.api[r.method](fill(r, 'not-a-uuid')).set(admin.auth).send({});
      const label = `${r.method.toUpperCase()} ${r.path}`;
      if (res.status !== 422) continue; // routes with non-uuid ids may answer 404/403; covered by the sweep above
      if (!declared(opFor(r)!, 422)) failures.push(`${label}: 422 not documented`);
      else {
        try {
          validate(r, 422, res.body, label);
        } catch (e) {
          failures.push((e as Error).message.slice(0, 400));
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('protected operations declare bearer security; public ones declare none', () => {
    const dept = routeRegistry.find((r) => r.method === 'get' && r.path === '/departments')!;
    expect(opFor(dept)!.security).toEqual([{ bearerAuth: [] }, { apiKeyAuth: [] }]);
    const login = routeRegistry.find((r) => r.operationId === 'loginWithPassword')!;
    expect(opFor(login)!.security).toEqual([]);
  });

  it('serves the frontend spec, the full spec and the YAML form', async () => {
    const json = await ctx.api.get('/api/docs/openapi.json');
    expect(json.status).toBe(200);
    expect(json.body.openapi).toBe('3.1.0');
    const full = await ctx.api.get('/api/docs/openapi.json?audience=full');
    expect(Object.keys(full.body.paths).length).toBeGreaterThan(Object.keys(json.body.paths).length);
    expect(Object.keys(json.body.paths).some((p) => p.startsWith('/api/v1/platform/'))).toBe(false);
    const yaml = await ctx.api.get('/api/docs/openapi.yaml');
    expect(yaml.status).toBe(200);
    expect(yaml.text).toMatch(/^openapi: 3\.1\.0/m);
    expect((await ctx.api.get('/api/docs/')).status).toBe(200);
    expect((await ctx.api.get('/api/redoc')).status).toBe(200);
  });
});
