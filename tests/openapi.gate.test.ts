import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import SwaggerParser from '@apidevtools/swagger-parser';
import { getCtx, type TestCtx } from './helpers/app.js';
import { createApp } from '../src/app.js';
import { buildOpenApi } from '../src/platform/openapi/buildSpec.js';
import { routeRegistry } from '../src/platform/http/route.js';
import { OPERATION_IDS } from '../src/platform/openapi/operations.js';
import { OPERATION_VERBS } from '../src/platform/openapi/naming.js';
import { TAGS } from '../src/platform/openapi/catalog.js';

/**
 * Completeness gates for the generated API documentation (docs/API_NAMING.md):
 * validity, route <-> spec parity, naming rules and documentation coverage.
 */
type Json = Record<string, any>;  
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

let ctx: TestCtx;
const full = buildOpenApi({ version: 'gate', audience: 'full' }) as Json;
const frontend = buildOpenApi({ version: 'gate', audience: 'frontend' }) as Json;
const operations = (doc: Json) =>
  Object.entries(doc.paths as Json).flatMap(([path, item]) =>
    METHODS.filter((m) => (item as Json)[m]).map((m) => ({ path, method: m, op: (item as Json)[m] as Json })));

beforeAll(async () => { ctx = await getCtx(); });
afterAll(async () => { await ctx.close(); });

/** Walks the real Express router stack and returns "method path" with {param} placeholders. */
function mountedRoutes(): string[] {
  const out: string[] = [];
  const visit = (stack: any[], prefix: string) => {  
    for (const layer of stack) {
      if (layer.route) {
        for (const m of Object.keys(layer.route.methods)) out.push(`${m} ${prefix}${String(layer.route.path)}`.replace(/:(\w+)/g, '{$1}'));
      } else if (layer.handle?.stack) {
        const subs: any[] = layer.handle.stack;  
        const isApi = subs.some((l) => l.route && String(l.route.path) === '/auth/login');
        visit(subs, isApi ? '/api/v1' : '/api');
      }
    }
  };
  const app = createApp(ctx.svc) as unknown as { router: { stack: any[] } };  
  visit(app.router.stack, '');
  // documentation UI routes and the scheduler tick (secret-gated infra hook) are not part of the API surface
  return out.filter((r) => !/ \/api\/(docs|redoc|openapi)/.test(r) && !/ \/api\/v1\/internal\/cron\//.test(r));
}

describe('OpenAPI gates', () => {
  it('the generated documents are valid OpenAPI 3.1 with resolvable references', async () => {
    await SwaggerParser.validate(structuredClone(full) as never);
    await SwaggerParser.validate(structuredClone(frontend) as never);
  });

  it('every mounted Express route is in the spec and every spec path has a handler (full audience)', () => {
    const mounted = new Set(mountedRoutes());
    const documented = new Set(operations(full).map((o) => `${o.method} ${o.path}`));
    expect([...mounted].filter((r) => !documented.has(r)).sort(), 'mounted but undocumented').toEqual([]);
    expect([...documented].filter((r) => !mounted.has(r)).sort(), 'documented but not mounted').toEqual([]);
    expect(mounted.size).toBe(routeRegistry.length + 4); // + health/live, health/ready, metrics, meta/version
  });

  it('flagged-off modules are included and tagged with their flag', () => {
    const flagged = operations(full).filter((o) => o.op['x-feature-flag']);
    expect(flagged.length).toBeGreaterThan(200);
    for (const o of flagged) expect(o.op.tags.length, o.op.operationId).toBe(1);
    expect(Object.keys(frontend.paths).some((p) => p.startsWith('/api/v1/platform/'))).toBe(false);
  });

  it('operationIds are unique camelCase verbNoun from the controlled vocabulary', () => {
    const seen = new Set<string>();
    for (const { op } of operations(full)) {
      const id = op.operationId as string;
      expect(id, id).toMatch(/^[a-z][a-zA-Z0-9]+$/);
      expect(seen.has(id), `duplicate ${id}`).toBe(false);
      seen.add(id);
      const verb = /^[a-z]+/.exec(id)![0]!;
      const known = (OPERATION_VERBS as readonly string[]).some((v) => id.startsWith(v) && /^[A-Z]/.test(id.slice(v.length) || 'X'));
      expect(known, `${id} does not start with a vocabulary verb (${verb})`).toBe(true);
    }
    expect(Object.values(OPERATION_IDS).length).toBe(new Set(Object.values(OPERATION_IDS)).size);
  });

  it('paths are plural kebab-case, descriptive parameters, no {id}', () => {
    for (const { path } of operations(full)) {
      expect(path, path).not.toMatch(/\{id\}/);
      for (const seg of path.split('/').filter(Boolean)) {
        if (seg.startsWith('{')) expect(seg, path).toMatch(/^\{[a-z][a-zA-Z0-9]*\}$/);
        else expect(seg, path).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      }
    }
  });

  it('Express path parameter names equal the OpenAPI ones and the handler still receives params.id', () => {
    for (const r of routeRegistry) {
      const names = [...r.path.matchAll(/:(\w+)/g)].map((m) => m[1]!);
      expect(names, `${r.method} ${r.path}`).not.toContain('id');
    }
  });

  it('schema components follow the naming rules', () => {
    for (const name of Object.keys(full.components.schemas as Json)) {
      expect(name, name).toMatch(/^[A-Z][A-Za-z0-9]+$/);
      expect(name, name).not.toMatch(/(Dto|Model|Obj|Data)$|Item[0-9]/);
    }
  });

  it('tags are human readable, ordered and every module maps to a tag', () => {
    const modules = new Set(routeRegistry.map((r) => r.module));
    const mapped = new Set(TAGS.flatMap((t) => t.modules));
    for (const m of modules) expect(mapped.has(m), `module ${m} has no tag`).toBe(true);
    expect(full.tags[0].name).toBe('Authentication');
    expect(full['x-tagGroups'].map((g: Json) => g.name)).toEqual(['Identity & Security', 'Organization', 'Operations', 'Platform Control']);
  });

  it('documentation coverage is 100%: description, summary, tags, security, request example, response example', () => {
    const all = operations(full);
    const stat = { description: 0, summary: 0, tags: 0, security: 0, requestExample: 0, responseExample: 0, errors: 0 };
    let withBody = 0;
    const gaps: string[] = [];
    for (const { op } of all) {
      const id = op.operationId as string;
      if ((op.description as string)?.length > 40) stat.description++; else gaps.push(`${id}: description`);
      if (op.summary && op.summary.length <= 60) stat.summary++; else gaps.push(`${id}: summary`);
      if (op.tags?.length === 1) stat.tags++; else gaps.push(`${id}: tags`);
      if (Array.isArray(op.security)) stat.security++; else gaps.push(`${id}: security`);
      if (op.requestBody) {
        withBody++;
        const media = Object.values(op.requestBody.content as Json)[0] as Json;
        if (media.example !== undefined || media.examples) stat.requestExample++; else gaps.push(`${id}: request example`);
      }
      const ok = Object.entries(op.responses as Json).filter(([s]) => /^2/.test(s));
      const okWithExample = ok.every(([, r]) => !r.content || Object.values(r.content as Json).every((m) => (m as Json).example !== undefined));
      if (ok.length && okWithExample) stat.responseExample++; else gaps.push(`${id}: response example`);
      if ('500' in op.responses) stat.errors++; else gaps.push(`${id}: 500`);
    }
    const total = all.length;
     
    console.log(`OpenAPI coverage: ${total} operations | descriptions ${stat.description}/${total} | summaries ${stat.summary}/${total} | tags ${stat.tags}/${total} | security ${stat.security}/${total} | request examples ${stat.requestExample}/${withBody} | response examples ${stat.responseExample}/${total} | error responses ${stat.errors}/${total}`);
    expect(gaps).toEqual([]);
  });

  it('authenticated operations document 401 and 403; operations with inputs document 422', () => {
    for (const { op } of operations(full)) {
      if ((op.security as unknown[]).length > 0 && op['x-rate-limit'] !== 'none') {
        expect(op.responses['401'], `${op.operationId} 401`).toBeTruthy();
        if (JSON.stringify(op.security).includes('bearerAuth')) expect(op.responses['403'], `${op.operationId} 403`).toBeTruthy();
      }
      if (op.requestBody) expect(op.responses['422'], `${op.operationId} 422`).toBeTruthy();
      if (op.parameters?.some((p: Json) => p.in === 'path' && p.name)) expect(op.responses['404'], `${op.operationId} 404`).toBeTruthy();
      if (op['x-rate-limit'] !== 'none') expect(op.responses['429'], `${op.operationId} 429`).toBeTruthy();
    }
  });
});
