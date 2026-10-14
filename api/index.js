// Vercel serverless entry: wraps the compiled Express app (built to dist/ by `npm run build`).
// Background work cannot rely on a long-lived process here, so jobs run inline and the
// outbox is flushed after each response plus on the /internal/cron/tick schedule.
import { waitUntil } from '@vercel/functions';
import pg from 'pg';
import express from 'express';

process.env.JOBS_DRIVER ??= 'inline';
process.env.DB_POOL_MAX ??= '3';

// Loaded lazily (not as top-level imports) so a failure shows up as a readable error response instead of a bare
// FUNCTION_INVOCATION_FAILED. Vercel's file tracer still follows these literal specifiers.
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

// API docs are built from route metadata only (no DB, mail or storage), so they are served by a light app that
// does not depend on the full service boot. They stay reachable even when the main API cannot start.
const DOCS_PATH = /^\/(?:api\/(?:docs|redoc|openapi\.json)(?:[/?]|$)|$)/;
let docsApp;
function docs() {
  docsApp ??= (async () => {
    await import('../dist/src/modules/index.js'); // registers every route into the registry the spec is built from
    const { mountDocs, docsEnabled } = await import('../dist/src/platform/openapi/serve.js');
    const flag = (process.env.SWAGGER ?? '').toLowerCase();
    const env = {
      NODE_ENV: process.env.NODE_ENV ?? 'production',
      SWAGGER: flag ? flag === 'true' || flag === '1' : undefined,
      APP_BASE_URL: process.env.APP_BASE_URL,
      DOCS_BASIC_AUTH_USER: process.env.DOCS_BASIC_AUTH_USER,
      DOCS_BASIC_AUTH_PASS: process.env.DOCS_BASIC_AUTH_PASS,
    };
    const app = express();
    if (docsEnabled(env)) {
      app.get('/', (_req, res) => res.redirect('/api/docs'));
      mountDocs(app, env, process.env.APP_VERSION ?? '0.1.0');
    }
    return app;
  })().catch((e) => {
    docsApp = undefined;
    throw e;
  });
  return docsApp;
}

function fail(res, where, e) {
  console.error(`[${where}]`, e);
  if (res.headersSent) return;
  res.statusCode = 500;
  res.setHeader('content-type', 'application/json');
  // the message names the failing module or setting (never values or secrets)
  res.end(JSON.stringify({ error: { code: 'STARTUP_FAILED', where, message: String(e?.message ?? e).slice(0, 500) } }));
}

async function mainHandler(req, res) {
  const { svc, app } = await init();
  res.on('finish', () => {
    waitUntil(svc.events.dispatchPending().catch((e) => svc.log.error({ err: e?.message }, 'outbox dispatch failed')));
  });
  return app(req, res);
}

export default async function handler(req, res) {
  try {
    if (req.method === 'GET' && DOCS_PATH.test(req.url ?? '/')) {
      let app;
      try {
        app = await docs();
      } catch (e) {
        return fail(res, 'docs', e);
      }
      return app(req, res, (err) => {
        if (err) return fail(res, 'docs', err);
        mainHandler(req, res).catch((e) => fail(res, 'api', e)); // not a docs route after all
      });
    }
    return await mainHandler(req, res);
  } catch (e) {
    return fail(res, 'api', e);
  }
}
