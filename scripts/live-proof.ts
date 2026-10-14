/* eslint-disable @typescript-eslint/no-explicit-any */
// Counts operations in the LIVE spec per tag/method and asserts the completeness invariants (docs/SWAGGER_PROGRESS.md).
import { readFileSync } from 'node:fs';
import '../src/modules/index.js';
import { routeRegistry } from '../src/platform/http/route.js';

const doc = JSON.parse(readFileSync(process.argv[2]!, 'utf8'));
const M = ['get', 'post', 'put', 'patch', 'delete'];
const byTag: Record<string, Record<string, number>> = {};
const ids = new Set<string>();
let total = 0, noDesc = 0, noExample = 0, idParams = 0, dupes = 0;
for (const [path, item] of Object.entries<any>(doc.paths)) {
  if (path.includes('{id}')) idParams++;
  for (const m of M) {
    const op = item[m]; if (!op) continue;
    total++;
    const t = (byTag[op.tags[0]] ??= {});
    t[m] = (t[m] ?? 0) + 1;
    if (ids.has(op.operationId)) dupes++; ids.add(op.operationId);
    if (!op.description || !op.summary) noDesc++;
    const ok = Object.entries<any>(op.responses).filter(([s]) => /^2/.test(s));
    if (!ok.length || ok.some(([, r]) => r.content && Object.values<any>(r.content).some((c) => c.example === undefined))) noExample++;
  }
}
console.log('| Tag | GET | POST | PUT | PATCH | DELETE | Total |\n|---|---|---|---|---|---|---|');
for (const [t, c] of Object.entries(byTag)) console.log(`| ${t} | ${c.get ?? 0} | ${c.post ?? 0} | ${c.put ?? 0} | ${c.patch ?? 0} | ${c.delete ?? 0} | ${Object.values(c).reduce((a, b) => a + b, 0)} |`);
const mt: Record<string, number> = {};
for (const t of Object.values(byTag)) for (const [m, n] of Object.entries(t)) mt[m] = (mt[m] ?? 0) + n;
console.log(`| **All** | ${mt.get} | ${mt.post} | ${mt.put} | ${mt.patch} | ${mt.delete} | **${total}** |`);
console.log(`\nregistry routes: ${routeRegistry.length} (+4 probe/meta routes) | spec operations: ${total} | missing description/summary: ${noDesc} | missing success example: ${noExample} | duplicate operationIds: ${dupes} | {id} paths: ${idParams}`);
if (total !== routeRegistry.length + 4 || noDesc || noExample || idParams || dupes) process.exit(1);
