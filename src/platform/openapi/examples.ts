import type { AnyRoute } from '../http/route.js';
import { DEMO } from './shared.js';
import { DEMO_UUID as DEMO_UUID_FALLBACK } from './describe.js';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const NAMED: Record<string, unknown> = {
  id: DEMO.projectId, organizationId: DEMO.organizationId, userId: DEMO.userId, projectId: DEMO.projectId, taskId: DEMO.taskId,
  invoiceId: DEMO.invoiceId, ownerId: DEMO.userId, assigneeId: DEMO.userId, createdBy: DEMO.userId, updatedBy: DEMO.userId,
  email: DEMO.email, name: 'Acme Design Studio', title: 'Quarterly website refresh', description: 'Refresh the marketing site for Q2.',
  password: 'Correct-Horse-Battery-9', newPassword: 'Correct-Horse-Battery-9', currentPassword: 'Correct-Horse-Battery-9',
  accessToken: DEMO.accessToken, refreshToken: 'rt_EXAMPLE_0f3a9c2e41b84d6e9a1b7c5d3e2f4a6b', token: 'tok_EXAMPLE_0f3a9c2e41b84d6e',
  currency: 'USD', amount: '1250.00', total: '1250.00', subtotal: '1000.00', taxTotal: '250.00', url: 'https://hooks.example.test/nexus',
  slug: 'getting-started', code: 'ACME', organizationCode: 'acme', organizationName: 'Acme Design Studio',
  status: 'active', timezone: 'Europe/London', locale: 'en-GB', mfaCode: '123456', requestId: DEMO.requestId,
  createdAt: DEMO.timestamp, updatedAt: DEMO.timestamp, rowVersion: 1, limit: 25, nextCursor: null, message: 'Done',
  note: 'Looks good to me.', comment: 'Approved after review.', reason: 'Requested by the customer.', filename: 'brief.pdf',
  contentType: 'application/pdf', size: 48213, phone: '+44 20 7946 0000', key: 'example_key', type: 'example',
};

const MAX_DEPTH = 9;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Known validation patterns in the code base -> a value that satisfies them. */
const PATTERN_SAMPLES: [string, string][] = [
  [String.raw`^\d{4}-\d{2}-\d{2}$`, DEMO.date],
  ['^#[0-9a-fA-F]{6}$', '#4f46e5'],
  [String.raw`^\d{1,15}(\.\d{1,6})?$`, '10.00'],
  ['^[a-z0-9_.-]{1,60}$', 'example_code'],
  ['^[A-Z0-9_]{3,64}$', 'SMTP_PASSWORD'],
  ['^[a-z][a-z0-9_.]{1,60}$', 'tasks.created'],
  ['^[a-z][a-z0-9_.]{2,60}$', 'task.approval'],
  ['^[a-z][a-z0-9_]{0,40}$', 'submitted'],
  ['^[a-z][a-z0-9_]{2,40}$', 'custom_role'],
  ['^[a-z0-9_.-]{2,60}$', 'task_priority'],
  ['^[a-z0-9_.]{3,60}$', 'module.projects'],
  ['^[a-z]{2}(-[A-Z]{2})?$', 'en-GB'],
  ['^[A-Za-z]{3}$', 'USD'],
  ['^[a-z0-9]+(?:-[a-z0-9]+)*$', 'getting-started'],
  [String.raw`^[\w.-]{8,128}$`, DEMO.requestId],
];
const fitLength = (v: string, s: Json): string => {
  let out = v;
  if (typeof s.minLength === 'number' && out.length < s.minLength) out = out.padEnd(s.minLength, 'x');
  if (typeof s.maxLength === 'number' && out.length > s.maxLength) out = out.slice(0, s.maxLength);
  return out;
};

function resolve(schema: Json | undefined, doc: Json): Json | undefined {
  let s = schema;
  for (let i = 0; i < 8 && s && typeof s.$ref === 'string'; i++) {
    const parts = (s.$ref as string).replace(/^#\//, '').split('/');
    s = parts.reduce<Json | undefined>((acc, p) => acc?.[p], doc);
  }
  return s;
}

export function exampleFor(schema: Json | undefined, doc: Json, name = '', depth = 0): unknown {
  const s = resolve(schema, doc);
  if (!s || depth > MAX_DEPTH) return null;
  if (s.example !== undefined) return s.example;
  if (s.const !== undefined) return s.const;
  if (Array.isArray(s.enum)) return s.enum[0];
  if (s.default !== undefined) return s.default;
  if (s.allOf) return Object.assign({}, ...s.allOf.map((x: Json) => exampleFor(x, doc, name, depth + 1) as object));
  if (s.anyOf || s.oneOf) {
    const options = (s.anyOf ?? s.oneOf) as Json[];
    const pick = options.find((o) => o.type !== 'null') ?? options[0];
    return exampleFor(pick, doc, name, depth + 1);
  }
  const type = Array.isArray(s.type) ? s.type.find((t: string) => t !== 'null') : s.type;
  switch (type) {
    case 'object': {
      const out: Json = {};
      const props = (s.properties ?? {}) as Json;
      const required = new Set<string>(s.required ?? []);
      let n = 0;
      for (const [k, v] of Object.entries(props)) {
        if (!required.has(k) && n >= 10) continue;
        if (k === 'meta' && !required.has(k) && !(v as Json).properties) continue;
        if (/^deletedAt$|^deleted_at$/.test(k)) { out[k] = null; continue; }
        out[k] = exampleFor(v as Json, doc, k, depth + 1);
        n++;
      }
      return out;
    }
    case 'array': {
      const one = exampleFor(s.items, doc, name, depth + 1);
      return Array.from({ length: Math.max(1, Number(s.minItems ?? 1)) }, () => one);
    }
    case 'integer':
    case 'number': {
      if (NAMED[name] !== undefined && typeof NAMED[name] === 'number') return NAMED[name];
      return s.minimum ?? (s.exclusiveMinimum !== undefined ? s.exclusiveMinimum + 1 : 1);
    }
    case 'boolean':
      return /^(is|has|send|notify)|enabled|active/i.test(name) ? true : false;
    case 'string':
    default: {
      if (s.pattern) {
        const hit = PATTERN_SAMPLES.find(([p]) => p === s.pattern);
        if (hit) return hit[1];
      }
      if (s.format === 'binary') return '(binary file content)';
      if (s.format === 'uuid') return typeof NAMED[name] === 'string' && UUID_RE.test(NAMED[name] as string) ? NAMED[name] : DEMO_UUID_FALLBACK;
      if (s.format === 'date-time') return DEMO.timestamp;
      if (s.format === 'date') return DEMO.date;
      if (s.format === 'email') return DEMO.email;
      if (s.format === 'uri' || s.format === 'url') return 'https://example.test/resource';
      if (typeof NAMED[name] === 'string') return fitLength(NAMED[name] as string, s);
      if (/Id$/.test(name)) return DEMO_UUID_FALLBACK;
      if (/(At|Time)$/.test(name)) return DEMO.timestamp;
      if (/Date$/.test(name) || name === 'from' || name === 'to') return DEMO.date;
      if (/email/i.test(name)) return DEMO.email;
      if (/url/i.test(name)) return 'https://example.test/resource';
      return fitLength(name ? `example ${name.replace(/([A-Z])/g, ' $1').toLowerCase()}` : 'example', s);
    }
  }
}

/** Adds a realistic request example and a success-response example to every operation that lacks one. */
export function addExamples(doc: Json, meta: Map<string, { r: AnyRoute }>): void {
  for (const [key, { r }] of meta) {
    const [method, ...rest] = key.split(' ');
    const op = doc.paths[rest.join(' ')]?.[method!] as Json | undefined;
    if (!op) continue;
    const body = op.requestBody?.content as Json | undefined;
    if (body) {
      for (const media of Object.values(body) as Json[]) {
        if (media.example !== undefined || media.examples) continue;
        if (r.requestExamples && Object.keys(r.requestExamples).length) {
          media.examples = Object.fromEntries(
            Object.entries(r.requestExamples).map(([k, v]) => [k, { summary: k.replace(/([A-Z])/g, ' $1').toLowerCase(), value: v }]),
          );
        } else {
          media.example = exampleFor(media.schema, doc);
        }
      }
    }
    for (const [status, resp] of Object.entries(op.responses ?? {}) as [string, Json][]) {
      if (!/^2/.test(status) || !resp.content) continue;
      for (const media of Object.values(resp.content) as Json[]) {
        if (media.example !== undefined) continue;
        if (media.schema?.format === 'binary') { media.example = '(binary file content)'; continue; }
        const ex = exampleFor(media.schema, doc) as Json | null;
        if (ex && typeof ex === 'object' && r.responseExample !== undefined && 'data' in ex) ex.data = r.responseExample;
        media.example = ex;
      }
    }
  }
}
