/**
 * Builds the OpenAPI 3.1 documents from the route registry and writes docs/openapi.{json,yaml} (frontend audience)
 * and docs/openapi.full.{json,yaml} (including internal operations).
 *
 *   npm run openapi:gen     write the artifacts
 *   npm run openapi:check   fail if the committed artifacts are stale or any route is undocumented
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { stringify } from 'yaml';
import '../src/modules/index.js';
import { buildOpenApi } from '../src/platform/openapi/buildSpec.js';
import { routeRegistry } from '../src/platform/http/route.js';
import { OPERATION_IDS } from '../src/platform/openapi/operations.js';

const check = process.argv.includes('--check');
const version = process.env.APP_VERSION ?? '1.0.0';

const problems: string[] = [];
const ids = new Map<string, string>();
for (const r of routeRegistry) {
  const key = `${r.method.toUpperCase()} ${r.catalogKey ?? r.path}`;
  if (!r.access) problems.push(`no access metadata: ${key}`);
  if (!r.operationId) problems.push(`no operationId (add to operations.ts): ${key}`);
  else if (ids.has(r.operationId)) problems.push(`duplicate operationId ${r.operationId}: ${key} and ${ids.get(r.operationId)}`);
  else ids.set(r.operationId, key);
}
const known = new Set(routeRegistry.map((r) => r.catalogKey));
for (const k of Object.keys(OPERATION_IDS)) if (!known.has(k)) problems.push(`operations.ts entry without a route: ${k}`);
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}

const frontend = buildOpenApi({ version, audience: 'frontend', baseUrl: process.env.APP_BASE_URL });
const full = buildOpenApi({ version, audience: 'full', baseUrl: process.env.APP_BASE_URL });
const outputs: Record<string, string> = {
  'docs/openapi.json': `${JSON.stringify(frontend, null, 2)}\n`,
  'docs/openapi.yaml': stringify(frontend),
  'docs/openapi.full.json': `${JSON.stringify(full, null, 2)}\n`,
  'docs/openapi.full.yaml': stringify(full),
};

if (check) {
  const stale = Object.entries(outputs).filter(([f, c]) => !existsSync(f) || readFileSync(f, 'utf8').replace(/\r\n/g, '\n') !== c);
  if (stale.length) {
    console.error(`Stale OpenAPI artifacts (run \`npm run openapi:gen\` and commit): ${stale.map(([f]) => f).join(', ')}`);
    process.exit(1);
  }
} else {
  mkdirSync('docs', { recursive: true });
  for (const [f, c] of Object.entries(outputs)) writeFileSync(f, c);
}
const ops = (d: typeof frontend) => Object.values(d.paths as Record<string, object>).reduce((n, p) => n + Object.keys(p).length, 0);
console.log(`openapi ${check ? 'check ok' : 'written'}: ${routeRegistry.length} registry routes, ${ops(frontend)} frontend operations, ${ops(full)} full operations`);
