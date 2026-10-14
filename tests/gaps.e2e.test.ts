import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:net';
import { getCtx, createActor, createPlatformAdmin, uniq, type TestCtx } from './helpers/app.js';
import { S3Storage } from '../src/platform/storage-s3.js';
import { HttpErrorTracker, MemoryErrorTracker, NoopErrorTracker, parseDsn } from '../src/platform/error-tracking.js';
import { ClamdScanner, StubScanner } from '../src/platform/files.js';
import { loadEnv } from '../src/config/env.js';
import { withPlatformScope } from '../src/platform/scope.js';

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await getCtx();
});
afterAll(async () => {
  await ctx.close();
});

describe('S3 storage driver', () => {
  it('stores privately encrypted objects, blocks traversal, maps 404 to exists=false', async () => {
    const sent: { name: string; input: Record<string, unknown> }[] = [];
    const objects = new Map<string, Buffer>();
    const fake = {
      async send(cmd: unknown) {
        const c = cmd as { constructor: { name: string }; input: Record<string, unknown> };
        sent.push({ name: c.constructor.name, input: c.input });
        const key = String(c.input.Key);
        if (c.constructor.name === 'PutObjectCommand') { objects.set(key, c.input.Body as Buffer); return {}; }
        if (c.constructor.name === 'GetObjectCommand') {
          const b = objects.get(key);
          return b ? { Body: { transformToByteArray: async () => new Uint8Array(b) } } : {};
        }
        if (c.constructor.name === 'DeleteObjectCommand') { objects.delete(key); return {}; }
        if (!objects.has(key)) throw Object.assign(new Error('nf'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
        return {};
      },
    };
    const s = new S3Storage({ bucket: 'b', region: 'us-east-1', prefix: 'nexus/' }, fake);
    await s.put('org/abc', Buffer.from('hello'));
    expect(sent[0]!.input).toMatchObject({ Bucket: 'b', Key: 'nexus/org/abc', ServerSideEncryption: 'AES256' });
    expect((await s.get('org/abc')).toString()).toBe('hello');
    expect(await s.exists('org/abc')).toBe(true);
    await s.delete('org/abc');
    expect(await s.exists('org/abc')).toBe(false);
    await expect(s.put('../x', Buffer.from('x'))).rejects.toThrow(/Invalid storage key/);
    await expect(s.get('missing')).rejects.toThrow();
  });

  it('config requires a bucket and rejects the stub scanner in production', () => {
    const base = { DATABASE_URL: 'postgres://u:p@localhost/db', JWT_SECRET: 'x'.repeat(40), DATA_ENCRYPTION_KEY: 'a'.repeat(64) };
    expect(() => loadEnv({ ...base, STORAGE_DRIVER: 's3' } as NodeJS.ProcessEnv)).toThrow(/S3_BUCKET/);
    expect(loadEnv({ ...base, STORAGE_DRIVER: 's3', S3_BUCKET: 'b' } as NodeJS.ProcessEnv).STORAGE_DRIVER).toBe('s3');
    expect(() => loadEnv({ ...base, NODE_ENV: 'production', MAIL_DRIVER: 'smtp', CORS_ORIGINS: 'https://a.example.test' } as NodeJS.ProcessEnv)).toThrow(/SCAN_DRIVER/);
  });
});

describe('malware scanner', () => {
  const daemon = (reply: string) =>
    new Promise<{ port: number; srv: Server }>((resolve) => {
      const srv = createServer((sock) => {
        let buf = Buffer.alloc(0);
        sock.on('data', (d) => {
          buf = Buffer.concat([buf, d as Buffer]);
          // clamd INSTREAM: the client terminates the stream with a zero-length chunk, then the daemon answers
          if (buf.length > 14 && buf.subarray(buf.length - 4).equals(Buffer.alloc(4))) sock.end(reply);
        });
      });
      srv.listen(0, '127.0.0.1', () => resolve({ port: (srv.address() as { port: number }).port, srv }));
    });

  it('stub flags EICAR; clamd driver fails closed when unreachable and parses verdicts', async () => {
    const eicar = Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*');
    expect(await new StubScanner().scan(eicar)).toBe('infected');
    expect(await new StubScanner().scan(Buffer.from('fine'))).toBe('clean');
    expect(await new ClamdScanner('127.0.0.1', 1).scan(Buffer.from('x'))).toBe('failed');
    for (const [reply, want] of [['stream: OK\0', 'clean'], ['stream: Eicar-Test-Signature FOUND\0', 'infected']] as const) {
      const { port, srv } = await daemon(reply);
      expect(await new ClamdScanner('127.0.0.1', port).scan(Buffer.from('payload'))).toBe(want);
      srv.close();
    }
  });
});

describe('error tracking', () => {
  it('parses DSNs and posts scrubbed events', async () => {
    expect(parseDsn('https://abc123@sentry.example.test/42')).toEqual({ url: 'https://sentry.example.test/api/42/store/', key: 'abc123' });
    expect(() => parseDsn('https://sentry.example.test/')).toThrow();
    const calls: { url: string; init: RequestInit }[] = [];
    const t = new HttpErrorTracker('https://abc123@sentry.example.test/42', {
      environment: 'test', release: '1',
      fetchFn: (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response('ok'); }) as unknown as typeof fetch,
    });
    t.capture(new Error('boom'), { requestId: 'r1', extra: { password: 'hunter2', note: 'ok' } });
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toHaveLength(1);
    expect(String(calls[0]!.init.body)).not.toContain('hunter2');
    expect(String(calls[0]!.init.body)).toContain('boom');
    expect((calls[0]!.init.headers as Record<string, string>)['x-sentry-auth']).toContain('sentry_key=abc123');
    new NoopErrorTracker().capture();
    const mem = new MemoryErrorTracker();
    mem.capture(new Error('x'), { route: '/r' });
    expect(mem.events[0]!.ctx.route).toBe('/r');
  });
});

describe('provisioning job records', () => {
  it('records completed and failed attempts and leaves nothing half-created', async () => {
    const pa = await createPlatformAdmin(ctx);
    const code = `job-${uniq().slice(0, 8)}`;
    const ok = await ctx.api.post('/api/v1/platform/tenants').set(pa.auth).set('Idempotency-Key', randomUUID())
      .send({ name: 'Job Co', code, adminEmail: `${uniq('p')}@example.test`, adminName: 'O' });
    expect(ok.status).toBe(201);
    expect(ok.body.data.jobId).toBeTruthy();
    const bad = await ctx.api.post('/api/v1/platform/tenants').set(pa.auth).set('Idempotency-Key', randomUUID())
      .send({ name: 'Job Co 2', code, adminEmail: `${uniq('q')}@example.test`, adminName: 'O' });
    expect(bad.status).toBe(409);
    const jobs = await ctx.api.get('/api/v1/platform/provisioning-jobs').set(pa.auth);
    expect(jobs.body.data.map((j: { status: string }) => j.status)).toEqual(expect.arrayContaining(['completed', 'failed']));
    const orgs = await withPlatformScope(ctx.svc.db, 'test', (t) => t('organizations').where({ code }).count({ c: '*' }).first());
    expect(Number((orgs as { c: string }).c)).toBe(1);
  });
});

describe('admin purge', () => {
  it('purges only soft-deleted records after the window, honouring legal hold; audited', async () => {
    const a = await createActor(ctx);
    const dep = await ctx.api.post('/api/v1/departments').set(a.auth).send({ name: `Purge ${uniq()}` });
    const id = dep.body.data.id;
    const purge = (rid: string) => ctx.api.post('/api/v1/retention/purge').set(a.auth).send({ resource: 'departments', id: rid });
    expect((await purge(id)).status).toBe(409);
    await ctx.api.delete(`/api/v1/departments/${id}`).set(a.auth);
    const early = await purge(id);
    expect(early.status).toBe(409);
    expect(JSON.stringify(early.body)).toContain('eligible_at');
    await withPlatformScope(ctx.svc.db, 'test', (t) => t('departments').where({ id }).update({ deleted_at: new Date(Date.now() - 40 * 86400_000) }));
    await ctx.api.put('/api/v1/retention/policies/departments').set(a.auth).send({ retentionDays: 30, legalHold: true });
    expect((await purge(id)).status).toBe(409);
    await ctx.api.put('/api/v1/retention/policies/departments').set(a.auth).send({ retentionDays: 30, legalHold: false });
    expect((await purge(id)).status).toBe(200);
    expect((await purge(id)).status).toBe(404);
    const audit = await ctx.api.get('/api/v1/audit-events').set(a.auth).query({ action: 'record.purged' });
    expect(audit.body.data).toHaveLength(1);
    expect((await ctx.api.post('/api/v1/retention/purge').set(a.auth).send({ resource: 'users', id })).status).toBe(422);
  });
});
