// Vercel serverless entry: wraps the compiled Express app (built to dist/ by `npm run build`).
// Background work cannot rely on a long-lived process here, so jobs run inline and the
// outbox is flushed after each response plus on the /internal/cron/tick schedule.
import { waitUntil } from '@vercel/functions';
import pg from 'pg';

process.env.JOBS_DRIVER ??= 'inline';
process.env.DB_POOL_MAX ??= '3';

let ready;
function init() {
  ready ??= (async () => {
    const { loadEnv } = await import('../dist/src/config/env.js');
    const { buildServices } = await import('../dist/src/bootstrap.js');
    const { createApp } = await import('../dist/src/app.js');
    const { RateLimiter } = await import('../dist/src/platform/rate-limit.js');
    const env = loadEnv();
    const svc = await buildServices(env);
    const store = env.RATE_LIMIT_STORE ?? (env.NODE_ENV === 'production' ? 'postgres' : 'memory');
    const pool = store === 'postgres' ? new pg.Pool({ connectionString: env.DATABASE_URL, max: 1 }) : null;
    return { svc, app: createApp(svc, { rateLimiter: new RateLimiter({}, pool ? { pool } : undefined) }) };
  })().catch((e) => {
    ready = undefined; // retry on the next invocation instead of caching a failed boot
    throw e;
  });
  return ready;
}

export default async function handler(req, res) {
  const { svc, app } = await init();
  res.on('finish', () => {
    waitUntil(svc.events.dispatchPending().catch((e) => svc.log.error({ err: e?.message }, 'outbox dispatch failed')));
  });
  return app(req, res);
}
