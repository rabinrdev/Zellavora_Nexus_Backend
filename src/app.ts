import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import helmetModule from 'helmet';
import cors from 'cors';
import hpp from 'hpp';
import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import client from 'prom-client';
import { AppError } from './platform/errors.js';
import { RateLimiter } from './platform/rate-limit.js';
import { mountRoutes } from './platform/http/route.js';
import { mountDocs } from './platform/openapi/serve.js';
import { newId, safeEqual } from './platform/crypto.js';
import { errorBody, successBody } from './platform/http/envelope.js';
import { withPlatformScope } from './platform/scope.js';
import type { Services } from './platform/types.js';

// helmet ships CJS-flavoured types; depending on resolution the default import is the module namespace.
type HelmetFactory = () => RequestHandler;
const helmetCandidate = helmetModule as unknown;
const helmet: HelmetFactory =
  typeof helmetCandidate === 'function' ? (helmetCandidate as HelmetFactory) : (helmetCandidate as { default: HelmetFactory }).default;

const requestId: RequestHandler = (req, res, next) => {
  const inbound = req.header('x-request-id');
  const id = inbound && /^[\w.-]{8,128}$/.test(inbound) ? inbound : randomUUID();
  res.locals.requestId = id;
  res.setHeader('X-Request-Id', id);
  next();
};

export interface ResponseObservation { method: string; route: string | undefined; status: number }

export function createApp(
  svc: Services,
  opts: { rateLimiter?: RateLimiter; /** test hook: called for every finished response */ observe?: (o: ResponseObservation) => void } = {},
) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', svc.env.TRUST_PROXY);
  app.set('query parser', 'extended');
  app.locals.rateLimiter = opts.rateLimiter ?? new RateLimiter();

  const registry = new client.Registry();
  client.collectDefaultMetrics({ register: registry });
  const httpHist = new client.Histogram({
    name: 'http_request_duration_seconds', help: 'HTTP request latency', labelNames: ['method', 'route', 'status'],
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5], registers: [registry],
  });

  app.use(requestId);
  app.use((req, res, next) => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const sec = Number(process.hrtime.bigint() - start) / 1e9;
      const route = (req.route?.path as string | undefined) ?? 'unmatched';
      opts.observe?.({ method: req.method.toLowerCase(), route: req.route?.path as string | undefined, status: res.statusCode });
      httpHist.observe({ method: req.method, route, status: String(res.statusCode) }, sec);
      // metadata only: never bodies, headers or query strings
      svc.log.info({ requestId: res.locals.requestId, method: req.method, path: req.path, status: res.statusCode, ms: Math.round(sec * 1000) }, 'request');
      const client = res.locals.apiClient as { id?: string; organizationId?: string | null } | undefined;
      if (client) {
        void withPlatformScope(svc.db, 'api-request-audit', (t) => t('api_request_audit').insert({
          id: newId(), organization_id: client.organizationId ?? null, client_id: client.id ?? null, route, method: req.method,
          status: res.statusCode, duration_ms: Math.round(sec * 1000), request_id: res.locals.requestId,
        })).catch(() => undefined); // metadata only; never blocks or fails the request
      }
    });
    next();
  });
  app.use(helmet(), cors({ origin: svc.env.CORS_ORIGINS }), hpp(), express.json({ limit: '1mb', verify: (req, _res, buf) => { (req as unknown as { rawBody?: Buffer }).rawBody = buf; } }));

  // health + metrics (outside the permission registry by design; no secrets exposed)
  app.get('/api/v1/health/live', (_req, res) => void res.json({ status: 'ok' }));
  app.get('/api/v1/health/ready', async (_req, res) => {
    const checks: Record<string, 'ok' | 'fail'> = {};
    try { await svc.db.raw('select 1'); checks.database = 'ok'; } catch { checks.database = 'fail'; }
    try { checks.mail = (await svc.mail.ping()) ? 'ok' : 'fail'; } catch { checks.mail = 'fail'; }
    try { await svc.storage.exists('__health__'); checks.storage = 'ok'; } catch { checks.storage = 'fail'; }
    const ready = Object.values(checks).every((v) => v === 'ok');
    res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'unavailable', checks });
  });
  app.get('/api/v1/metrics', async (req, res) => {
    const tok = svc.env.METRICS_TOKEN;
    const given = (req.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (tok ? !safeEqual(tok, given) : svc.env.NODE_ENV === 'production') {
      res.status(404).json(errorBody('NOT_FOUND', 'Resource not found', [], res.locals.requestId));
      return;
    }
    res.setHeader('Content-Type', registry.contentType);
    res.send(await registry.metrics());
  });
  // scheduler tick (serverless hosts have no long-lived process): flush the outbox and enqueue hourly jobs
  app.get('/api/v1/internal/cron/tick', async (req, res, next) => {
    try {
      const tok = svc.env.CRON_SECRET;
      const given = (req.get('authorization') ?? '').replace(/^Bearers+/i, '');
      if (!tok || !safeEqual(tok, given)) {
        res.status(404).json(errorBody('NOT_FOUND', 'Resource not found', [], res.locals.requestId));
        return;
      }
      const dispatched = await svc.events.dispatchPending(500);
      await svc.jobs.enqueue('retention', {});
      res.json(successBody({ dispatched }));
    } catch (e) {
      next(e);
    }
  });
  app.get('/api/v1/meta/version', (_req, res) =>
    void res.json(successBody({ version: svc.env.APP_VERSION, gitSha: svc.env.GIT_SHA, apiVersions: ['v1'] })),
  );

  // API version lifecycle (F-244): Deprecation / Sunset headers when a version is deprecated
  let policyCache: { at: number; rows: { version: string; status: string; sunset_at: Date | null }[] } = { at: 0, rows: [] };
  app.use('/api/v1', async (_req, res, next) => {
    try {
      if (Date.now() - policyCache.at > 60_000) policyCache = { at: Date.now(), rows: await svc.db('api_version_policy').select('version', 'status', 'sunset_at') };
      const v1 = policyCache.rows.find((r) => r.version === 'v1');
      if (v1 && v1.status !== 'current') {
        res.setHeader('Deprecation', 'true');
        if (v1.sunset_at) res.setHeader('Sunset', new Date(v1.sunset_at).toUTCString());
      }
    } catch { /* policy lookup must never break requests */ }
    next();
  });

  // maintenance mode (F-048): everything except health checks and platform admins
  app.use('/api/v1', async (req, res, next) => {
    if (req.path.startsWith('/health') || req.path.startsWith('/meta') || req.path.startsWith('/config/public')) return next();
    try {
      const row = await svc.db('application_settings').where({ key: 'maintenance_mode' }).first();
      if (row?.value === true) {
        res.setHeader('Retry-After', '300');
        throw new AppError('MAINTENANCE', 'The service is undergoing maintenance');
      }
      next();
    } catch (e) {
      next(e);
    }
  });

  const router = express.Router();
  mountRoutes(router, svc);
  app.use('/api/v1', router);

  mountDocs(app, svc.env, svc.env.APP_VERSION);

  app.use((_req, _res, next) => next(new AppError('NOT_FOUND', 'Resource not found')));

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    let e: AppError;
    if (err instanceof AppError) e = err;
    else if (err instanceof ZodError)
      e = new AppError('VALIDATION_FAILED', 'Request validation failed', err.issues.map((i) => ({ field: i.path.join('.'), issue: i.message })));
    else if (err?.type === 'entity.parse.failed') e = new AppError('VALIDATION_FAILED', 'Malformed JSON body');
    else if (err?.type === 'entity.too.large') e = new AppError('VALIDATION_FAILED', 'Request body too large');
    else {
      svc.log.error({ err: { message: err?.message, name: err?.name }, requestId: res.locals.requestId }, 'unhandled error');
      svc.tracker.capture(err, { requestId: res.locals.requestId, route: _req.route?.path as string | undefined, method: _req.method });
      e = new AppError('INTERNAL', 'Internal server error'); // never leak internals
    }
    const retryAfter = (e as AppError & { retryAfter?: number }).retryAfter;
    if (retryAfter) res.setHeader('Retry-After', String(retryAfter));
    res.status(e.status).json(errorBody(e.code, e.message, e.details, res.locals.requestId));
  };
  app.use(onError);
  return app;
}
