import 'dotenv/config';
import { loadEnv } from './config/env.js';
import { buildServices } from './bootstrap.js';
import { createApp } from './app.js';
import pg from 'pg';
import { RateLimiter } from './platform/rate-limit.js';

const env = loadEnv();
const svc = await buildServices(env);
await svc.jobs.start();
await svc.jobs.schedule('retention', '15 * * * *');

const rlStore = env.RATE_LIMIT_STORE ?? (env.NODE_ENV === 'production' ? 'postgres' : 'memory');
const rlPool = rlStore === 'postgres' ? new pg.Pool({ connectionString: env.DATABASE_URL, max: 4 }) : null;
const app = createApp(svc, { rateLimiter: new RateLimiter({}, rlPool ? { pool: rlPool } : undefined) });
const server = app.listen(env.PORT, () => svc.log.info({ port: env.PORT }, 'listening'));
server.requestTimeout = 30_000;

// outbox dispatcher
const tick = setInterval(() => {
  svc.events.dispatchPending().catch((e) => svc.log.error({ err: e?.message }, 'outbox dispatch failed'));
}, 2000);

let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  svc.log.info({ signal }, 'shutting down');
  clearInterval(tick);
  server.close(async () => {
    await svc.jobs.stop().catch(() => undefined);
    await rlPool?.end().catch(() => undefined);
    await svc.db.destroy();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 15_000).unref();
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
