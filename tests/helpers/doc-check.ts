import { buildOpenApi } from '../../src/platform/openapi/buildSpec.js';
import type { ResponseObservation } from '../../src/app.js';

type Doc = { paths: Record<string, Record<string, { operationId: string; responses: Record<string, unknown> }>> };
let doc: Doc | undefined;

/**
 * Every response any e2e test caused must be a status the OpenAPI document declares for that operation.
 * Called from `ctx.close()` so each test file proves the docs against real traffic.
 */
export function assertObservedStatusesDocumented(observed: ResponseObservation[]): void {
  doc ??= buildOpenApi({ version: 'test', audience: 'full' }) as unknown as Doc;
  const undocumented = new Map<string, Set<number>>();
  for (const o of observed) {
    if (!o.route) continue; // 404 for unknown URLs, docs UI, etc.
    const key = `/api/v1${o.route.replace(/:(\w+)/g, '{$1}')}`;
    const op = doc.paths[key]?.[o.method];
    if (!op) continue; // not an API operation (docs, redoc assets)
    if (o.status === 304) continue;
    if (!(String(o.status) in op.responses)) {
      const k = `${o.method.toUpperCase()} ${key} [${op.operationId}]`;
      (undocumented.get(k) ?? undocumented.set(k, new Set()).get(k)!).add(o.status);
    }
  }
  if (undocumented.size) {
    const lines = [...undocumented].map(([k, s]) => `  ${k}: ${[...s].sort().join(', ')}`);
    throw new Error(`Responses observed in tests are not documented in OpenAPI:\n${lines.join('\n')}`);
  }
}
