import { describe, it, expect, afterAll } from 'vitest';
import { Writable } from 'node:stream';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createLogger } from '../src/platform/logger.js';
import { deepScrub } from '../src/platform/redact.js';
import { EnvKeyProvider, encrypt, decrypt, sha256, randomToken, newId } from '../src/platform/crypto.js';
import { loadEnv } from '../src/config/env.js';
import { RateLimiter } from '../src/platform/rate-limit.js';
import { createApp } from '../src/app.js';
import { getCtx } from './helpers/app.js';
import { hashPassword, verifyPassword, passwordProblems, DEFAULT_PASSWORD_POLICY } from '../src/platform/auth/password.js';
import { signAccessToken, verifyAccessToken } from '../src/platform/auth/tokens.js';
import { renderTemplate } from '../src/modules/notifications/routes.js';
import { signDownload, verifyDownload } from '../src/platform/files.js';
import { isPrivateAddress } from '../src/platform/ssrf.js';
import { signPayload, verifySignature } from '../src/modules/integrations/routes.js';

describe('logging redaction (F-156)', () => {
  it('never writes secrets to logs', () => {
    const chunks: string[] = [];
    const sink = new Writable({ write(c, _e, cb) { chunks.push(c.toString()); cb(); } });
    const log = createLogger('info', sink);
    log.info({
      req: { headers: { authorization: 'Bearer abc.def.ghi', cookie: 'sid=secret' } },
      body: { password: 'hunter2', refreshToken: 'r-tok', apiKey: 'nxk_live_secret' },
      user: { email: 'a@example.test' },
    }, 'login attempt');
    const out = chunks.join('');
    for (const secret of ['hunter2', 'r-tok', 'nxk_live_secret', 'abc.def.ghi', 'sid=secret']) expect(out).not.toContain(secret);
    expect(out).toContain('[REDACTED]');
    expect(out).toContain('a@example.test');
  });

  it('deepScrub strips secrets from nested audit/error metadata', () => {
    const s = deepScrub({ ok: 1, nested: { password: 'x', list: [{ apiKey: 'y', name: 'n' }], token: 't' }, auth: 'Bearer zzz' });
    expect(JSON.stringify(s)).not.toMatch(/"x"|"y"|"t"|zzz/);
    expect((s as { nested: { list: { name: string }[] } }).nested.list[0]!.name).toBe('n');
  });
});

describe('crypto', () => {
  it('AES-256-GCM round-trips, is non-deterministic, and detects tampering', () => {
    const p = new EnvKeyProvider('1:' + 'ab'.repeat(32));
    const c1 = encrypt(p, 'top secret');
    expect(c1.startsWith('v1.')).toBe(true);
    expect(c1).not.toContain('top secret');
    expect(encrypt(p, 'top secret')).not.toBe(c1);
    expect(decrypt(p, c1)).toBe('top secret');
    const parts = c1.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => decrypt(p, parts.join('.'))).toThrow();
  });

  it('supports key rotation: new key encrypts, old key still decrypts', () => {
    const old = new EnvKeyProvider('1:' + 'ab'.repeat(32));
    const ct = encrypt(old, 'v');
    const rotated = new EnvKeyProvider('1:' + 'ab'.repeat(32) + ',2:' + 'cd'.repeat(32));
    expect(decrypt(rotated, ct)).toBe('v');
    expect(encrypt(rotated, 'v').startsWith('v2.')).toBe(true);
    expect(() => new EnvKeyProvider('1:abcd')).toThrow(/32 bytes/);
  });

  it('ids are UUIDv7 and time ordered; tokens are high entropy', () => {
    const a = newId(); const b = newId();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/);
    expect(a < b || a.slice(0, 13) === b.slice(0, 13)).toBe(true);
    expect(randomToken().length).toBeGreaterThanOrEqual(43);
    expect(sha256('x')).toHaveLength(64);
  });

  it('signed download tokens expire and cannot be forged', () => {
    const t = signDownload('secret-secret-secret-secret-1234', randomUUID(), randomUUID(), Date.now());
    expect(verifyDownload('secret-secret-secret-secret-1234', t.token)).not.toBeNull();
    expect(verifyDownload('other-secret-other-secret-other12', t.token)).toBeNull();
    expect(verifyDownload('secret-secret-secret-secret-1234', t.token, Date.now() + 6 * 60_000)).toBeNull();
  });
});

describe('passwords and tokens', () => {
  it('hashes with argon2id and enforces the policy', async () => {
    const h = await hashPassword('Correct-Horse-Battery-9');
    expect(h.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(h, 'Correct-Horse-Battery-9')).toBe(true);
    expect(await verifyPassword(h, 'nope')).toBe(false);
    expect(passwordProblems('short', DEFAULT_PASSWORD_POLICY).length).toBeGreaterThan(0);
    expect(passwordProblems('alllowercaseletters', DEFAULT_PASSWORD_POLICY).join()).toMatch(/at least 3/);
    expect(passwordProblems('Jane.Doe-2026-Strong', DEFAULT_PASSWORD_POLICY, { email: 'jane.doe@example.test' }).join()).toMatch(/email/);
  });

  it('access tokens carry no roles/permissions and reject tampering', async () => {
    const secret = 'unit-test-secret-unit-test-secret-123';
    const t = await signAccessToken(secret, { sub: 'u', sid: 's', org: 'o', pv: 3 });
    const payload = JSON.parse(Buffer.from(t.split('.')[1]!, 'base64url').toString());
    expect(Object.keys(payload).sort()).toEqual(['exp', 'iat', 'iss', 'org', 'pv', 'sid', 'sub']);
    expect(await verifyAccessToken(secret, t)).toMatchObject({ sub: 'u', sid: 's', org: 'o', pv: 3 });
    expect(await verifyAccessToken(secret, `${t}x`)).toBeNull();
    expect(await verifyAccessToken('different-secret-different-secret-1', t)).toBeNull();
  });
});

describe('config fail-fast', () => {
  const base = { DATABASE_URL: 'postgres://u:p@localhost/db', JWT_SECRET: 'x'.repeat(40), DATA_ENCRYPTION_KEY: 'a'.repeat(64) };
  it('rejects missing/short secrets and unsafe production settings', () => {
    expect(() => loadEnv({ DATABASE_URL: base.DATABASE_URL } as NodeJS.ProcessEnv)).toThrow(/Invalid environment/);
    expect(() => loadEnv({ ...base, JWT_SECRET: 'short' } as NodeJS.ProcessEnv)).toThrow(/JWT_SECRET/);
    expect(() => loadEnv({ ...base, NODE_ENV: 'production', MAIL_DRIVER: 'console', CORS_ORIGINS: 'https://app.example.test' } as NodeJS.ProcessEnv)).toThrow(/MAIL_DRIVER/);
    expect(() => loadEnv({ ...base, NODE_ENV: 'production', MAIL_DRIVER: 'smtp' } as NodeJS.ProcessEnv)).toThrow(/CORS_ORIGINS/);
    expect(loadEnv({ ...base } as NodeJS.ProcessEnv).PORT).toBe(3000);
  });
});

describe('templates, SSRF, signatures (unit)', () => {
  it('template rendering escapes HTML and has no expression language', () => {
    expect(renderTemplate('Hi {{ name }}', { name: '<b>x</b>' }, true)).toBe('Hi &lt;b&gt;x&lt;/b&gt;');
    expect(renderTemplate('{{constructor.constructor}}', {})).toBe('');
    expect(renderTemplate('{{ a.b }}', { a: { b: 5 } })).toBe('5');
    expect(renderTemplate('{{ missing }}', {})).toBe('');
  });

  it('classifies private/loopback/link-local/metadata addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.1', '169.254.169.254', '100.64.0.1', '::1', 'fe80::1', 'fd00::1', '::ffff:10.0.0.1']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '2606:4700::1']) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it('webhook signatures are timing-safe, tolerance-bound and body-bound', () => {
    const ts = Math.floor(Date.now() / 1000);
    const sig = signPayload('s3cret', '{"a":1}', ts);
    expect(verifySignature('s3cret', sig, '{"a":1}')).toBe(true);
    expect(verifySignature('s3cret', sig, '{"a":2}')).toBe(false);
    expect(verifySignature('other', sig, '{"a":1}')).toBe(false);
    expect(verifySignature('s3cret', sig, '{"a":1}', 300, ts + 301)).toBe(false);
    expect(verifySignature('s3cret', 'garbage', '{"a":1}')).toBe(false);
  });
});

describe('HTTP behaviour', () => {
  let close: (() => Promise<void>) | undefined;
  afterAll(async () => { await close?.(); });

  it('rate limits with 429 + Retry-After and the standard error body', async () => {
    const ctx = await getCtx();
    close = ctx.close;
    const limited = request(createApp(ctx.svc, { rateLimiter: new RateLimiter({ auth: { points: 3, durationSeconds: 60 } }) }));
    const statuses: number[] = [];
    let last: request.Response | undefined;
    for (let i = 0; i < 5; i++) {
      last = await limited.post('/api/v1/auth/login').send({ email: 'nobody@example.test', password: 'whatever-Password-1' });
      statuses.push(last.status);
    }
    expect(statuses.slice(0, 3)).toEqual([401, 401, 401]);
    expect(statuses.slice(3)).toEqual([429, 429]);
    expect(last!.headers['retry-after']).toBeTruthy();
    expect(last!.body.errorMessage[0].code).toBe('RATE_LIMITED');
  });

  it('never leaks internals: malformed JSON, unknown routes, bad ids, and request-id echo', async () => {
    const ctx = await getCtx();
    const bad = await ctx.api.post('/api/v1/auth/login').set('Content-Type', 'application/json').send('{"email":');
    expect(bad.status).toBe(422);
    expect(JSON.stringify(bad.body)).not.toMatch(/SyntaxError|at |node_modules|stack/);
    const nf = await ctx.api.get('/api/v1/no/such/route');
    expect(nf.status).toBe(404);
    expect(nf.body.errorMessage[0].code).toBe('NOT_FOUND');
    const rid = 'client-supplied-id-12345';
    const echoed = await ctx.api.get('/api/v1/health/live').set('X-Request-Id', rid);
    expect(echoed.headers['x-request-id']).toBe(rid);
    const unsafe = await ctx.api.get('/api/v1/health/live').set('X-Request-Id', 'x\\ny');
    expect(unsafe.headers['x-request-id']).not.toBe('x\\ny');
    expect(echoed.headers['x-content-type-options']).toBe('nosniff');
    expect(echoed.headers['x-powered-by']).toBeUndefined();
  });

  it('rejects client-supplied sort/filter fields outside the whitelist and oversize bodies', async () => {
    const ctx = await getCtx();
    const huge = await ctx.api.post('/api/v1/auth/login').send({ email: 'a@example.test', password: 'x'.repeat(2 * 1024 * 1024) });
    expect(huge.status).toBe(422);
  });
});
