// Vercel serverless handler (bundled into dist/vercel/handler.mjs by scripts/build-vercel.mjs; api/index.js re-exports it).
// Background work cannot rely on a long-lived process here, so jobs run inline and the outbox is flushed after
// each response plus on the /internal/cron/tick schedule.
import { waitUntil } from '@vercel/functions';
import express from 'express';
import type { Express, Request, Response } from 'express';
import pg from 'pg';
import { loadEnv } from '../config/env.js';
import { buildServices } from '../bootstrap.js';
import { createApp } from '../app.js';
import { RateLimiter } from '../platform/rate-limit.js';
import { mountDocs, docsEnabled } from '../platform/openapi/serve.js';
import type { Services } from '../platform/types.js';
import '../modules/index.js'; // registers every route into the registry the OpenAPI document is built from

process.env.JOBS_DRIVER ??= 'inline';
process.env.DB_POOL_MAX ??= '3';

let ready: Promise<{ svc: Services; app: Express }> | undefined;
function init() {
  ready ??= (async () => {
    const env = loadEnv();
    const svc = await buildServices(env);
    const store = env.RATE_LIMIT_STORE ?? (env.NODE_ENV === 'production' ? 'postgres' : 'memory');
    const pool = store === 'postgres' ? new pg.Pool({ connectionString: env.DATABASE_URL, max: 1 }) : null;
    return { svc, app: createApp(svc, { rateLimiter: new RateLimiter({}, pool ? { pool } : undefined) }) };
  })().catch((e: unknown) => {
    ready = undefined; // retry on the next invocation instead of caching a failed boot
    throw e;
  });
  return ready;
}

// API docs are built from route metadata only (no DB, mail or storage), so they are served by a light app that
// does not depend on the full service boot. They stay reachable even when the main API cannot start.
// /api/docs*, /api/redoc*, /api/openapi.json, or the root-level UI: /, /index.html and the swagger-ui assets
const DOCS_PATH =
  /^\/(?:api\/(?:docs|redoc|openapi\.json)(?:[/?]|$)|(?:index\.html|swagger-ui[\w.-]*\.(?:css|js)|favicon-(?:16x16|32x32)\.png)?(?:\?.*)?$)/;
let docsApp: Express | undefined;
function docs(): Express {
  if (docsApp) return docsApp;
  const flag = (process.env.SWAGGER ?? '').toLowerCase();
  const env = {
    NODE_ENV: (process.env.NODE_ENV ?? 'production') as 'development' | 'test' | 'production',
    SWAGGER: flag ? flag === 'true' || flag === '1' : undefined,
    APP_BASE_URL: process.env.APP_BASE_URL,
    DOCS_BASIC_AUTH_USER: process.env.DOCS_BASIC_AUTH_USER,
    DOCS_BASIC_AUTH_PASS: process.env.DOCS_BASIC_AUTH_PASS,
  };
  const app = express();
  if (docsEnabled(env)) {
    mountDocs(app, env as unknown as Parameters<typeof mountDocs>[1], process.env.APP_VERSION ?? '0.1.0');
  }
  docsApp = app;
  return app;
}

function fail(res: Response, where: string, e: unknown) {
  console.error(`[${where}]`, e);
  if (res.headersSent) return;
  // raw node response: this can run before express has decorated it
  res.statusCode = 500;
  res.setHeader('content-type', 'application/json');
  res.end(
    JSON.stringify({
      // names the failing module or setting, never values or secrets
      error: { code: 'STARTUP_FAILED', where, node: process.version, message: String((e as Error)?.message ?? e).slice(0, 500) },
    }),
  );
}

async function mainHandler(req: Request, res: Response) {
  const { svc, app } = await init();
  res.on('finish', () => {
    waitUntil(svc.events.dispatchPending().catch((e: Error) => svc.log.error({ err: e?.message }, 'outbox dispatch failed')));
  });
  app(req, res);
}

export default async function handler(req: Request, res: Response) {
  try {
    if (req.method === 'GET' && DOCS_PATH.test(req.url ?? '/')) {
      return docs()(req, res, (err?: unknown) => {
        if (err) return fail(res, 'docs', err);
        mainHandler(req, res).catch((e: unknown) => fail(res, 'api', e)); // not a docs route after all
      });
    }
    return await mainHandler(req, res);
  } catch (e) {
    return fail(res, 'api', e);
  }
}
