import { createRequire } from 'node:module';
import path from 'node:path';
import express, { type Express, type RequestHandler } from 'express';
import helmet from 'helmet';
import swaggerUi from 'swagger-ui-express';
import { stringify as yamlStringify } from 'yaml';
import { safeEqual } from '../crypto.js';
import { buildOpenApi, type Audience } from './buildSpec.js';
import type { Env } from '../../config/env.js';

const require = createRequire(import.meta.url);

export function docsEnabled(env: Pick<Env, 'SWAGGER' | 'NODE_ENV'>): boolean {
  return env.SWAGGER ?? env.NODE_ENV !== 'production';
}

/** HTTP Basic gate (staging): `DOCS_BASIC_AUTH_USER` / `DOCS_BASIC_AUTH_PASS`. */
function basicGate(user: string, pass: string): RequestHandler {
  return (req, res, next) => {
    const h = req.get('authorization') ?? '';
    if (h.startsWith('Basic ')) {
      const [u = '', ...rest] = Buffer.from(h.slice(6), 'base64').toString('utf8').split(':');
      if (safeEqual(u, user) && safeEqual(rest.join(':'), pass)) return next();
    }
    res.setHeader('WWW-Authenticate', 'Basic realm="Zellavora Nexus API docs"');
    res.status(401).send('Authentication required');
  };
}

const audienceOf = (v: unknown): Audience => (v === 'full' ? 'full' : 'frontend');

// Rendered as a function by swagger-ui-express: logical method order inside each tag, then path.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const operationsSorter = (a: any, b: any) => {
  const order = ['get', 'post', 'patch', 'put', 'delete'];
  const d = order.indexOf(a.get('method')) - order.indexOf(b.get('method'));
  return d !== 0 ? d : String(a.get('path')).localeCompare(String(b.get('path')));
};

/**
 * Mounts /api/docs (Swagger UI), /api/redoc (Redoc), /api/docs/openapi.{json,yaml} and the legacy /api/openapi.json.
 * Enabled by `SWAGGER` (default: on outside production). Never exposes secrets: the spec is built from route metadata only.
 */
export function mountDocs(app: Express, env: Env, version: string): void {
  if (!docsEnabled(env)) return;
  const production = env.NODE_ENV === 'production';
  const cache = new Map<Audience, ReturnType<typeof buildOpenApi>>();
  const spec = (a: Audience) => {
    let doc = cache.get(a);
    if (!doc) {
      doc = buildOpenApi({ version, baseUrl: env.APP_BASE_URL, audience: a, production });
      cache.set(a, doc);
    }
    return doc;
  };

  const gate: RequestHandler[] = env.DOCS_BASIC_AUTH_USER && env.DOCS_BASIC_AUTH_PASS ? [basicGate(env.DOCS_BASIC_AUTH_USER, env.DOCS_BASIC_AUTH_PASS)] : [];
  // Swagger UI / Redoc need inline styles and blob workers; scripts stay same-origin only.
  const docsCsp = helmet.contentSecurityPolicy({
    directives: {
      defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'], imgSrc: ["'self'", 'data:', 'blob:'],
      workerSrc: ["'self'", 'blob:'], connectSrc: ["'self'"], objectSrc: ["'none'"], frameAncestors: ["'none'"],
    },
  });

  const router = express.Router();
  router.use(...gate, docsCsp);
  router.get('/docs/openapi.json', (req, res) => void res.json(spec(audienceOf(req.query.audience))));
  router.get('/docs/openapi.yaml', (req, res) => {
    res.type('application/yaml').send(yamlStringify(spec(audienceOf(req.query.audience))));
  });
  router.get('/openapi.json', (_req, res) => void res.json(spec('frontend'))); // kept for existing tooling

  router.use(
    '/docs',
    swaggerUi.serve,
    swaggerUi.setup(null, {
      swaggerUrl: '/api/docs/openapi.json',
      customSiteTitle: 'Zellavora Nexus API',
      customCss: '.swagger-ui .topbar { display: none } .swagger-ui .info .title small.version-stamp { background:#4f46e5 }',
      swaggerOptions: {
        persistAuthorization: true, displayOperationId: true, filter: true, deepLinking: true, docExpansion: 'none',
        defaultModelsExpandDepth: 2, defaultModelExpandDepth: 3, operationsSorter, tagsSorter: () => 0,
        requestSnippetsEnabled: true, displayRequestDuration: true,
        // "Try it out" is available outside production only
        ...(production ? { supportedSubmitMethods: [] } : {}),
      },
    }),
  );

  const redocVersion = (require('redoc/package.json') as { version: string }).version; // in the URL so an upgrade never serves a stale cached bundle
  const redocDir = path.dirname(require.resolve('redoc/bundles/redoc.standalone.js'));
  router.use(`/redoc/assets/${redocVersion}`, express.static(redocDir, { index: false, maxAge: '1d' }));
  router.get('/redoc', (_req, res) => {
    res.type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Zellavora Nexus API — Reference</title>
<style>body{margin:0}</style></head>
<body><redoc spec-url="/api/docs/openapi.json" hide-hostname="false" expand-responses="200,201,202" path-in-middle-panel="true"></redoc>
<script src="/api/redoc/assets/${redocVersion}/redoc.standalone.js"></script></body></html>`);
  });
  app.use('/api', router);
}
