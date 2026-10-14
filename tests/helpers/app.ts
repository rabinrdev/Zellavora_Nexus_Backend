import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { loadEnv } from '../../src/config/env.js';
import { buildServices } from '../../src/bootstrap.js';
import { createApp, type ResponseObservation } from '../../src/app.js';
import { assertObservedStatusesDocumented } from './doc-check.js';
import { MemoryMailProvider } from '../../src/platform/mail.js';
import { MemoryStorage } from '../../src/platform/storage.js';
import { RateLimiter } from '../../src/platform/rate-limit.js';
import type { Services } from '../../src/platform/types.js';
import { currentTotp } from '../../src/platform/auth/totp.js';

export const STRONG_PASSWORD = 'Correct-Horse-Battery-9';

export interface HttpCall { url: string; headers: Record<string, string>; body: string }
export interface TestCtx {
  svc: Services;
  /** Outbound HTTP captured by the fake fetch (webhooks). Set `respond` to control status codes. */
  http: { calls: HttpCall[]; respond: (call: HttpCall) => number };
  mail: MemoryMailProvider;
  storage: MemoryStorage;
  api: ReturnType<typeof request>;
  close(): Promise<void>;
}

let shared: TestCtx | null = null;

export async function getCtx(): Promise<TestCtx> {
  if (shared) return shared;
  const mail = new MemoryMailProvider();
  const storage = new MemoryStorage();
  const http = { calls: [] as HttpCall[], respond: (_c: HttpCall) => 200 };
  const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
    const call = { url: String(url), headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)), body: String(init?.body ?? '') };
    http.calls.push(call);
    return new Response('ok', { status: http.respond(call) });
  }) as typeof fetch;
  const svc = await buildServices(loadEnv(), { mail, storage, fetch: fakeFetch, resolver: async (h) => (h.endsWith('.test') ? ['93.184.216.34'] : ['127.0.0.1']) });
  const big = { points: 100000, durationSeconds: 60 };
  const rateLimiter = new RateLimiter({ default: big, auth: big, mfa: big, invitation: big, apikey: big, search: big });
  const observed: ResponseObservation[] = [];
  const app = createApp(svc, { rateLimiter, observe: (o) => observed.push(o) });
  shared = {
    svc, http, mail, storage, api: request(app),
    close: async () => {
      await svc.db.destroy();
      shared = null;
      assertObservedStatusesDocumented(observed);
    },
  };
  return shared;
}

export function tokenFromMail(mail: MemoryMailProvider, to: string): string {
  const m = mail.last(to);
  const t = m?.text.match(/token: (\S+)/)?.[1];
  if (!t) throw new Error(`no token mail for ${to}`);
  return t;
}

export interface Actor {
  email: string;
  userId: string;
  organizationId: string | null;
  accessToken: string;
  refreshToken: string;
  auth: { Authorization: string };
}

export const uniq = (p = 'u') => `${p}-${randomUUID().slice(0, 8)}`;

/** Registers (organization or individual), verifies email and logs in. */
export async function createActor(
  ctx: TestCtx,
  opts: { kind?: 'individual' | 'organization'; name?: string; orgName?: string } = {},
): Promise<Actor> {
  const email = `${uniq()}@example.test`;
  const kind = opts.kind ?? 'organization';
  const r = await ctx.api.post('/api/v1/auth/register').send({
    kind, name: opts.name ?? 'Test Person', email, password: STRONG_PASSWORD,
    ...(kind === 'organization' ? { organizationName: opts.orgName ?? `Org ${uniq('o')}` } : {}),
  });
  if (r.status !== 202) throw new Error(`register failed ${r.status} ${JSON.stringify(r.body)}`);
  const v = await ctx.api.post('/api/v1/auth/verify-email').send({ token: tokenFromMail(ctx.mail, email) });
  if (v.status !== 200) throw new Error(`verify failed ${JSON.stringify(v.body)}`);
  return loginActor(ctx, email);
}

export async function loginActor(ctx: TestCtx, email: string, extra: Record<string, unknown> = {}): Promise<Actor> {
  const l = await ctx.api.post('/api/v1/auth/login').send({ email, password: STRONG_PASSWORD, ...extra });
  if (l.status !== 200) throw new Error(`login failed ${l.status} ${JSON.stringify(l.body)}`);
  const me = await ctx.api.get('/api/v1/auth/me').set('Authorization', `Bearer ${l.body.data.accessToken}`);
  return {
    email, userId: me.body.data.user.id, organizationId: l.body.data.organizationId,
    accessToken: l.body.data.accessToken, refreshToken: l.body.data.refreshToken,
    auth: { Authorization: `Bearer ${l.body.data.accessToken}` },
  };
}

export { currentTotp };

/** Promotes a freshly registered individual to platform admin (test-only DB write) and logs in again. */
export async function createPlatformAdmin(ctx: TestCtx): Promise<Actor> {
  const a = await createActor(ctx, { kind: 'individual' });
  const { withPlatformScope } = await import('../../src/platform/scope.js');
  await withPlatformScope(ctx.svc.db, 'test', (t) => t('users').where({ id: a.userId }).update({ is_platform_admin: true, permission_version: t.raw('permission_version + 1') }));
  return loginActor(ctx, a.email);
}
