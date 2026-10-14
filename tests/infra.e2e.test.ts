import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { getCtx, uniq, type TestCtx } from './helpers/app.js';
import { RateLimiter } from '../src/platform/rate-limit.js';
import { PgBossJobQueue } from '../src/platform/jobs.js';
import { withPlatformScope } from '../src/platform/scope.js';

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await getCtx();
});
afterAll(async () => {
  await ctx.close();
});

describe('shared (Postgres) rate limiter', () => {
  it('shares counters across instances and fails open to per-instance limiting on store errors', async () => {
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
    try {
      const cfg = { auth: { points: 3, durationSeconds: 60 } };
      const a = new RateLimiter(cfg, { pool });
      const b = new RateLimiter(cfg, { pool }); // a second "instance"
      const key = `ip:${uniq('rl')}`;
      await a.consume('auth', key);
      await b.consume('auth', key);
      await a.consume('auth', key);
      await expect(b.consume('auth', key)).rejects.toMatchObject({ code: 'RATE_LIMITED' }); // 4th hit across instances
      const err = await a.consume('auth', key).catch((e) => e);
      expect((err as { retryAfter?: number }).retryAfter).toBeGreaterThan(0);

      // broken store: insurance limiter keeps the API serving (and still limits locally)
      const dead = new pg.Pool({ connectionString: 'postgres://nope:nope@127.0.0.1:1/none', max: 1 });
      dead.on('error', () => undefined);
      const c = new RateLimiter({ auth: { points: 2, durationSeconds: 60 } }, { pool: dead });
      const k2 = `ip:${uniq('rl')}`;
      await c.consume('auth', k2);
      await c.consume('auth', k2);
      await expect(c.consume('auth', k2)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
      await dead.end().catch(() => undefined);
    } finally {
      await pool.end();
    }
  });
});

describe('pg-boss against a live PostgreSQL', () => {
  it('starts, creates queues + DLQs, runs handlers, records job_runs, and honours multiple handlers', async () => {
    const url = process.env.MIGRATOR_DATABASE_URL!; // pg-boss manages its own schema and needs DDL rights
    const q = new PgBossJobQueue(url, ctx.svc.db, { pollingIntervalSeconds: 0.5 });
    const seen: string[] = [];
    q.work('mail', async (d) => { seen.push(`a:${String(d.n)}`); });
    q.work('mail', async (d) => { seen.push(`b:${String(d.n)}`); });
    await q.start();
    try {
      await q.schedule('retention', '0 3 * * *'); // cron registration must not throw
      const n = uniq('job');
      await q.enqueue('mail', { n });
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline && seen.length < 2) await new Promise((r) => setTimeout(r, 250));
      expect(seen).toEqual([`a:${n}`, `b:${n}`]);
      const runs = await withPlatformScope(ctx.svc.db, 'test', (t) => t('job_runs').where({ queue: 'mail', status: 'completed' }).count({ c: '*' }).first());
      expect(Number((runs as { c: string }).c)).toBeGreaterThan(0);
      const pg2 = new pg.Pool({ connectionString: url });
      const dlq = await pg2.query(`select name from pgboss.queue where name = 'mail.dlq'`);
      await pg2.end();
      expect(dlq.rows).toHaveLength(1); // dead-letter queue exists for retries that are exhausted
    } finally {
      await q.stop();
    }
  });
});
