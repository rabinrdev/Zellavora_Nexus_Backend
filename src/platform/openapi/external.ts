import { z } from 'zod';
import { ErrorResponseSchema, statusFields } from './shared.js';

/**
 * Routes mounted directly in app.ts (outside the permissioned route registry, by design): probes, metrics, version.
 * They are documented here so that the spec lists 100% of mounted routes; the parity test keeps this list honest.
 */
export interface ExternalRoute {
  method: 'get';
  /** Path relative to /api/v1, express-style. */
  path: string;
  operationId: string;
  summary: string;
  description: string;
  auth: 'none' | 'metricsToken';
  /** Excluded from the `frontend` audience. */
  internal?: boolean;
  responses: { status: number; description: string; schema?: z.ZodType; contentType?: string }[];
}

export const externalRoutes: ExternalRoute[] = [
  {
    method: 'get', path: '/health/live', operationId: 'getHealthLive', summary: 'Liveness probe', auth: 'none',
    description: 'Returns `200` while the process is running. Does not touch dependencies. Use for container liveness checks.',
    responses: [{ status: 200, description: 'The process is alive.', schema: z.object({ status: z.literal('ok').openapi({ description: 'Always `ok`.', example: 'ok' }) }) }],
  },
  {
    method: 'get', path: '/health/ready', operationId: 'getHealthReady', summary: 'Readiness probe', auth: 'none',
    description: 'Checks the database, mail transport and object storage. `503` when any check fails — safe for load balancers and the maintenance banner.',
    responses: [
      {
        status: 200, description: 'All dependencies are healthy.',
        schema: z.object({
          status: z.enum(['ready', 'unavailable']).openapi({ description: 'Overall readiness.', example: 'ready' }),
          checks: z.record(z.string(), z.enum(['ok', 'fail'])).openapi({ description: 'Result per dependency (`database`, `mail`, `storage`).', example: { database: 'ok', mail: 'ok', storage: 'ok' } }),
        }),
      },
      {
        status: 503, description: 'At least one dependency check failed.',
        schema: z.object({
          status: z.enum(['ready', 'unavailable']).openapi({ description: 'Overall readiness.', example: 'unavailable' }),
          checks: z.record(z.string(), z.enum(['ok', 'fail'])).openapi({ description: 'Result per dependency.', example: { database: 'fail', mail: 'ok', storage: 'ok' } }),
        }),
      },
    ],
  },
  {
    method: 'get', path: '/metrics', operationId: 'getMetrics', summary: 'Prometheus metrics', auth: 'metricsToken', internal: true,
    description: 'Prometheus text exposition. In production it requires `Authorization: Bearer <METRICS_TOKEN>` and otherwise returns `404`.',
    responses: [
      { status: 200, description: 'Prometheus text format.', schema: z.string().openapi({ description: 'Prometheus exposition format.' }), contentType: 'text/plain' },
      { status: 404, description: 'Metrics are disabled or the token is wrong.', schema: ErrorResponseSchema },
    ],
  },
  {
    method: 'get', path: '/meta/version', operationId: 'getApiVersion', summary: 'Get API and build version', auth: 'none',
    description: 'Returns the application version, git SHA and the API versions served. Available during maintenance.',
    responses: [{
      status: 200, description: 'Version metadata.',
      schema: z.object({
        ...statusFields,
        data: z.object({
          version: z.string().openapi({ description: 'Application version.', example: '1.0.0' }),
          gitSha: z.string().nullable().openapi({ description: 'Git commit of the running build.', example: '6f9923a' }),
          apiVersions: z.array(z.string()).openapi({ description: 'Supported API versions.', example: ['v1'] }),
        }),
      }),
    }],
  },
];
