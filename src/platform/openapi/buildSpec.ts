import { OpenAPIRegistry, OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { routeRegistry, permissionOf, type AnyRoute } from '../http/route.js';
import { listQuerySchema } from '../pagination.js';
import { TAGS, TAG_GROUPS, INTERNAL_PATHS, tagFor, type TagDef } from './catalog.js';
import { DEMO, ERROR_CODES, ErrorResponseSchema, PaginationMetaSchema, ValidationErrorResponseSchema, statusFields } from './shared.js';
import { gettingStartedGuide } from './guide.js';
import { addExamples, exampleFor } from './examples.js';
import { describeProperty, humanize, paramDescription, paramExample } from './describe.js';
import { externalRoutes, type ExternalRoute } from './external.js';
import { webhookDefinitions } from './webhooks.js';
import { pascal, singularize } from './naming.js';

export type Audience = 'frontend' | 'full';

export interface BuildOptions {
  version: string;
  /** Public base URL of the API (APP_BASE_URL). */
  baseUrl?: string;
  audience?: Audience;
  routes?: AnyRoute[];
  /** Production disables "Try it out" servers pointing at localhost. */
  production?: boolean;
}

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const PREFIX = '/api/v1';
const openapiPath = (p: string) => `${PREFIX}${p.replace(/:(\w+)/g, '{$1}')}`;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export interface HandlerFacts {
  statuses: number[];
  usesIfMatch: boolean;
  contentTypes: string[];
}

/** Facts the handler body states about itself (statuses it returns, concurrency header, raw content types). */
export function inspectHandler(r: AnyRoute): HandlerFacts {
  const src = String(r.handler);
  const statuses = [...src.matchAll(/status:\s*(\d{3})/g)].map((m) => Number(m[1]));
  return {
    statuses,
    usesIfMatch: /if-match/i.test(src),
    contentTypes: [...new Set([...src.matchAll(/contentType:\s*'([\w.+/-]+)'/g)].map((m) => m[1]!))],
  };
}

export function scopeOf(r: AnyRoute): 'tenant' | 'user' | 'platform' {
  return r.scope ?? (r.access === 'public' || r.access === 'platformAdmin' ? 'platform' : 'tenant');
}

export type RouteKind = 'list' | 'get' | 'create' | 'update' | 'replace' | 'delete' | 'action';
export function kindOf(r: AnyRoute): RouteKind {
  const endsWithParam = /:\w+$/.test(r.path);
  if (r.method === 'get') return r.query === listQuerySchema || (!endsWithParam && r.list) ? 'list' : 'get';
  if (r.method === 'post') return /\/(:\w+|[^/]+)$/.test(r.path) && /^(create|add|record|register|upload|issue|start|import|grant|ingest)/.test(r.operationId ?? '') ? 'create' : 'action';
  if (r.method === 'patch') return 'update';
  if (r.method === 'put') return 'replace';
  return 'delete';
}

export function successStatuses(r: AnyRoute): number[] {
  if (r.successStatus !== undefined) return Array.isArray(r.successStatus) ? r.successStatus : [r.successStatus];
  const found = [...new Set(inspectHandler(r).statuses.filter((s) => s >= 200 && s < 300))].sort();
  if (found.length) return found;
  if (r.binary) return [200];
  return [r.method === 'post' ? 201 : r.method === 'delete' && !r.response ? 204 : 200];
}

function errorStatuses(r: AnyRoute): number[] {
  const s = new Set<number>([429, 500]);
  const facts = inspectHandler(r);
  const isMeta = r.path === '/config/public';
  if (!isMeta) s.add(503);
  if (r.access !== 'public') {
    s.add(401);
    s.add(403);
  }
  if (r.access === 'public' && securityFor(r).length > 0) s.add(401); // portal token required
  if (r.params || r.paramAliases || r.moduleFlag) s.add(404);
  if (r.params || r.query || r.body || r.upload || r.idempotent === 'required') s.add(422);
  // 409 only where the code can raise it: uniqueness (mapDbError), explicit CONFLICT, or an in-flight idempotency key
  if (r.method !== 'get' && (r.idempotent || /CONFLICT|mapDbError|409/.test(String(r.handler)))) s.add(409);
  if (r.entitlement || (r.moduleFlag && scopeOf(r) === 'tenant' && r.access !== 'public')) s.add(402);
  if (facts.usesIfMatch || (r.body && 'shape' in (r.body as object) && 'rowVersion' in ((r.body as z.ZodObject).shape ?? {}))) s.add(412);
  for (const e of r.errors ?? []) s.add(e);
  return [...s].sort((a, b) => a - b);
}

const ERROR_REF: Record<number, string> = {
  401: 'Unauthenticated', 402: 'PlanLimitExceeded', 403: 'Forbidden', 404: 'NotFound', 409: 'Conflict',
  412: 'PreconditionFailed', 422: 'ValidationFailed', 429: 'RateLimited', 500: 'InternalError', 503: 'Maintenance',
};

function securityFor(r: AnyRoute): Json[] {
  if (r.access === 'public') return r.path.startsWith('/portal/me/') ? [{ portalAuth: [] }] : [];
  const userOnly = scopeOf(r) === 'user' || r.access === 'platformAdmin' || r.path.startsWith('/auth/') || r.path.startsWith('/me/');
  return userOnly ? [{ bearerAuth: [] }] : [{ bearerAuth: [] }, { apiKeyAuth: [] }];
}

/** Re-keys a params schema from the handler's internal names to the exposed, descriptive ones. */
function exposedParams(r: AnyRoute): z.ZodType | undefined {
  const params = r.params as z.ZodType | undefined;
  if (!params) return undefined;
  const shape = (params as z.ZodObject).shape as Record<string, z.ZodType> | undefined;
  const aliases = r.paramAliases ?? {};
  const internalToExposed = Object.fromEntries(Object.entries(aliases).map(([e, i]) => [i, e]));
  if (!shape) return params;
  const out: Record<string, z.ZodType> = {};
  for (const [k, v] of Object.entries(shape)) {
    const name = internalToExposed[k] ?? k;
    out[name] = v.openapi({ description: paramDescription(name), example: paramExample(name) });
  }
  return z.object(out);
}

const QUERY_TEXT: Record<string, { d: string; e: unknown }> = {
  limit: { d: 'Maximum number of items to return (1-100). Defaults to 25.', e: 25 },
  cursor: { d: 'Opaque cursor from `meta.nextCursor` of the previous page. Omit for the first page.', e: 'eyJ2IjoiQWNtZSIsImlkIjoiMTIzIn0' },
  page: { d: 'Switches to offset pagination and selects the 1-based page. `meta.total` is then included.', e: 1 },
  pageSize: { d: 'Page size when `page` is used (1-100). Defaults to `limit`.', e: 25 },
  q: { d: 'Free-text search over the resource\'s searchable columns (case-insensitive contains).', e: 'acme' },
};

function listQueryFor(r: AnyRoute): z.ZodType {
  const shape: Record<string, z.ZodType> = {
    limit: z.coerce.number().int().min(1).max(100).default(25).openapi({ description: QUERY_TEXT.limit!.d, example: 25 }),
    cursor: z.string().max(512).optional().openapi({ description: QUERY_TEXT.cursor!.d, example: QUERY_TEXT.cursor!.e as string }),
    page: z.coerce.number().int().min(1).optional().openapi({ description: QUERY_TEXT.page!.d, example: 1 }),
    pageSize: z.coerce.number().int().min(1).max(100).optional().openapi({ description: QUERY_TEXT.pageSize!.d, example: 25 }),
  };
  const sortable = r.list?.sortable ?? [];
  const def = r.list?.defaultSort ?? '';
  shape.sort = (sortable.length
    ? z.enum([...sortable.flatMap((s) => [s, `-${s}`])] as [string, ...string[]])
    : z.string().max(64)
  ).optional().openapi({
    description: sortable.length
      ? `Sort field; prefix with \`-\` for descending. Allowed: ${sortable.map((s) => `\`${s}\``).join(', ')}. Default: \`${def}\`.`
      : 'Sort field; prefix with `-` for descending. Unknown fields return 422.',
    example: sortable[0] ?? 'name',
  });
  if (r.list?.searchable !== false) shape.q = z.string().max(200).optional().openapi({ description: QUERY_TEXT.q!.d, example: 'acme' });
  for (const f of r.list?.filterable ?? []) {
    shape[`filter[${f}]`] = z.string().optional().openapi({
      description: `Filter by \`${f}\` (exact match; comma-separated values mean "any of").`, example: f === 'status' ? 'active' : undefined,
    });
  }
  return z.object(shape);
}

function bodyFor(r: AnyRoute): z.ZodType | undefined {
  if (!r.upload) return r.body as z.ZodType | undefined;
  const shape: Record<string, z.ZodType> = {
    [r.upload.field]: z.string().openapi({
      format: 'binary',
      description: `The file to upload${r.upload.maxBytes ? ` (max ${Math.round(r.upload.maxBytes / 1024 / 1024)} MB)` : ' (size limited by the organization storage quota and MAX_UPLOAD_BYTES)'}. Content type is sniffed server-side; executables are rejected.`,
    }),
  };
  const b = r.body as z.ZodObject | undefined;
  if (b?.shape) Object.assign(shape, b.shape);
  return z.object(shape);
}

/** `Pascal(operationId)` — the component-name stem for this operation's request/response schemas. */
const stem = (r: AnyRoute) => pascal(r.operationId!.replace(/([A-Z])/g, '-$1').toLowerCase());

function accessTable(r: AnyRoute): string {
  const rows: [string, string][] = [];
  const perm = permissionOf(r);
  rows.push(['Authentication', r.access === 'public' ? 'None (public)' : r.path.startsWith('/portal/me/') ? '`portalAuth` bearer token' : 'Bearer access token' + (securityFor(r).length > 1 ? ' or API key' : '')]);
  rows.push(['Required permission', perm ? `\`${perm}\`` : r.access === 'platformAdmin' ? 'Platform administrator' : r.access === 'authenticated' ? 'Any signed-in user' : 'None']);
  rows.push(['Tenant scoped', scopeOf(r) === 'tenant' ? 'Yes — the active organization comes from the token; never send `organizationId`' : scopeOf(r) === 'user' ? 'No — acts on the signed-in user' : 'No — platform level']);
  if (r.moduleFlag) rows.push(['Feature flag', `\`${r.moduleFlag}\` (disabled modules return \`404 NOT_FOUND\`)`]);
  if (r.featureIds?.length) rows.push(['Feature IDs', r.featureIds.join(', ')]);
  if (r.audit) rows.push(['Audited', `Yes — \`${r.audit.action}\``]);
  rows.push(['Idempotency', r.idempotent === 'required' ? '`Idempotency-Key` header **required**' : r.idempotent ? '`Idempotency-Key` header supported' : 'Not applicable']);
  rows.push(['Rate limit', `\`${r.rateLimit ?? 'default'}\` bucket (429 + \`Retry-After\`)`]);
  if (r.asyncJob) rows.push(['Async', 'Returns `202`; poll the returned resource for completion']);
  return ['| | |', '|---|---|', ...rows.map(([k, v]) => `| **${k}** | ${v} |`)].join('\n');
}

function describeOperation(r: AnyRoute, tag: TagDef): string {
  const kind = kindOf(r);
  const noun = humanize(singularize(r.path.split('/').filter((s) => !s.startsWith(':')).pop() ?? 'resource'));
  const lines: string[] = [];
  lines.push(r.description ?? `${cap(r.summary.replace(/\.$/, ''))}.`);
  if (!r.description) {
    switch (kind) {
      case 'list':
        lines.push(`Returns one page of ${noun} records the caller may see in the active organization, in \`data\` with \`meta\`. Use \`meta.nextCursor\` as \`cursor\` to fetch the next page. Unknown \`sort\`/\`filter[...]\` fields return \`422\`.`);
        break;
      case 'get':
        lines.push('Returns a single record. A record that does not exist, was soft-deleted or belongs to another organization returns `404` (never `403`), so existence is not disclosed.');
        break;
      case 'create':
        lines.push('Creates the record in the active organization. Server-derived fields (`organizationId`, `createdBy`, timestamps, ids) are ignored if sent.');
        break;
      case 'update':
        lines.push('Applies a partial update: only the fields you send change. Where the resource has a `rowVersion`, send it (or `If-Match`) to detect concurrent edits (`412`).');
        break;
      case 'replace':
        lines.push('Replaces the stored value with the one sent; omitted collection members are removed.');
        break;
      case 'delete':
        lines.push('Removes the record. Resources that support restore are soft-deleted and can be brought back with the matching `restore` operation.');
        break;
      default:
        lines.push('Performs the named action on the resource and returns its new state. Invalid state transitions return `409`.');
    }
  }
  lines.push('', accessTable(r), '', `_Module: ${tag.name} · ${tag.release}_`);
  return lines.join('\n');
}

const SUCCESS_TEXT: Record<number, string> = { 200: 'OK', 201: 'Created', 202: 'Accepted — processing continues asynchronously', 204: 'No Content' };

export function buildOpenApi(opts: BuildOptions) {
  const audience = opts.audience ?? 'frontend';
  const all = opts.routes ?? routeRegistry;
  const registry = new OpenAPIRegistry();

  // ---- security schemes
  registry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http', scheme: 'bearer', bearerFormat: 'JWT',
    description: 'Access token from `loginWithPassword` / `refreshAccessToken`. Lifetime is short; refresh with the refresh token (returned in the body, not a cookie).',
  });
  registry.registerComponent('securitySchemes', 'apiKeyAuth', {
    type: 'http', scheme: 'bearer', bearerFormat: 'nxk_…',
    description: 'Machine API key created with `createApiKey`, sent as `Authorization: Bearer nxk_…`. Permissions are limited to the key\'s scopes.',
  });
  registry.registerComponent('securitySchemes', 'portalAuth', {
    type: 'http', scheme: 'bearer', bearerFormat: 'JWT',
    description: 'Client-portal access token from `loginToPortal`. Separate realm: it is not accepted by staff endpoints.',
  });

  // ---- shared schemas
  registry.register('ErrorResponse', ErrorResponseSchema);
  registry.register('ValidationErrorResponse', ValidationErrorResponseSchema);
  registry.register('PaginationMeta', PaginationMetaSchema);

  // ---- select routes for the audience
  const internalRoute = (r: AnyRoute) => tagFor(r.module, r.path).internal === true || INTERNAL_PATHS.has(r.path);
  const routes = all.filter((r) => audience === 'full' || !internalRoute(r));
  const meta = new Map<string, { r: AnyRoute; tag: TagDef }>();
  const componentNames = new Map<string, z.ZodType>();
  const registerOnce = (name: string, schema: z.ZodType): z.ZodType => {
    if (componentNames.has(name)) return componentNames.get(name)!;
    const s = registry.register(name, schema);
    componentNames.set(name, s);
    return s;
  };

  for (const r of routes) {
    if (!r.operationId) throw new Error(`Route ${r.method.toUpperCase()} ${r.catalogKey ?? r.path} has no operationId (add it to src/platform/openapi/operations.ts)`);
    const tag = tagFor(r.module, r.path);
    const method = r.method;
    const path = openapiPath(r.path);
    const st = stem(r);
    let query: z.ZodType | undefined;
    if (r.query) {
      if (r.query === listQuerySchema || kindOf(r) === 'list') {
        const base = listQueryFor(r) as z.ZodObject;
        const own = ((r.query as z.ZodObject).shape ?? {}) as Record<string, z.ZodType>;
        const baseKeys = Object.keys(listQuerySchema.shape);
        const extra = Object.fromEntries(Object.entries(own).filter(([k]) => !baseKeys.includes(k)));
        query = Object.keys(extra).length ? base.extend(extra) : base;
      } else query = r.query as z.ZodType;
    }
    const bodySchema = bodyFor(r);
    const contentType = r.upload ? 'multipart/form-data' : (r.contentType ?? 'application/json');
    const request: Json = {};
    const params = exposedParams(r);
    if (params) request.params = params;
    if (query) request.query = query;
    if (bodySchema) {
      const reqName = r.requestName ?? `${st}Request`;
      request.body = { required: true, content: { [contentType]: { schema: registerOnce(reqName, bodySchema.openapi({ description: `Request body of \`${r.operationId}\`.` })) } } };
    }

    const responses: Json = {};
    for (const status of successStatuses(r)) {
      if (status === 204) {
        responses[204] = { description: SUCCESS_TEXT[204] };
        continue;
      }
      if (r.binary || inspectHandler(r).contentTypes.length) {
        const types = r.binary ? (inspectHandler(r).contentTypes.length ? inspectHandler(r).contentTypes : ['application/octet-stream']) : [];
        if (types.length) {
          responses[status] = { description: 'The file content.', content: Object.fromEntries(types.map((t) => [t, { schema: { type: 'string', format: 'binary' } }])) };
          continue;
        }
      }
      const data = (r.response as z.ZodType | undefined) ?? z.record(z.string(), z.unknown());
      if (r.bare) {
        responses[status] = {
          description: SUCCESS_TEXT[status] ?? 'Success',
          content: { 'application/json': { schema: registerOnce(`${st}Response`, data.openapi({ description: `Success response of \`${r.operationId}\` (bare JSON, not the envelope).` })) } },
        };
        continue;
      }
      const paginatedList = kindOf(r) === 'list';
      const listLike = paginatedList || r.collection === true;
      const name = r.responseName ?? st;
      const item = r.responseName ? registerOnce(r.responseName, data) : undefined;
      const envelope = listLike
        ? z.object(paginatedList ? { ...statusFields, data: z.array(item ?? data), meta: PaginationMetaSchema } : { ...statusFields, data: z.array(item ?? data) })
        : z.object({ ...statusFields, data: item ?? data, meta: z.record(z.string(), z.unknown()).optional().openapi({ description: 'Operation-specific metadata.' }) });
      const envName = listLike && r.responseName ? `${name}ListResponse` : `${name}Response`;
      responses[status] = {
        description: SUCCESS_TEXT[status] ?? 'Success',
        content: { 'application/json': { schema: registerOnce(envName, envelope.openapi({ description: `Success response of \`${r.operationId}\`.` })) } },
      };
    }

    registry.registerPath({
      method,
      path,
      operationId: r.operationId,
      summary: cap(r.summary.replace(/\.$/, '')),
      description: describeOperation(r, tag),
      tags: [tag.name],
      request,
      responses,
    } as never);
    meta.set(`${method} ${path}`, { r, tag });
  }

  // ---- external (non-registry) routes: health, metrics, version
  const externals = externalRoutes.filter((e) => audience === 'full' || !e.internal);
  for (const e of externals) registerExternal(registry, e);

  const generator = new OpenApiGeneratorV31(registry.definitions);
  const doc = generator.generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'Zellavora Nexus API',
      version: opts.version,
      description: gettingStartedGuide(),
      contact: { name: 'Zellavora Nexus API support', email: 'api-support@example.test' },
    },
    servers: [
      { url: '/', description: 'This server (same origin; used by "Try it out")' },
      ...(opts.baseUrl ? [{ url: opts.baseUrl, description: opts.production ? 'Production' : 'Configured base URL' }] : []),
    ],
  }) as Json;

  // ---- request bodies are *input* types: fields with a server default are optional for the caller
  for (const [name, schema] of Object.entries((doc.components?.schemas ?? {}) as Json)) {
    if (!name.endsWith('Request') || !Array.isArray(schema.required)) continue;
    schema.required = schema.required.filter((k: string) => schema.properties?.[k]?.default === undefined);
    if (schema.required.length === 0) delete schema.required;
  }

  // ---- post-pass: errors, headers, params, security, extensions
  doc.components ??= {};
  Object.assign(doc.components, sharedComponents());
  for (const [key, { r, tag }] of meta) {
    const [method, ...rest] = key.split(' ');
    const op = doc.paths[rest.join(' ')]?.[method!] as Json | undefined;
    if (!op) continue;
    op.security = securityFor(r);
    op.parameters = [...(op.parameters ?? [])];
    patchOperation(doc, op, r, tag);
  }
  for (const e of externals) patchExternal(doc, e);

  const tagList = TAGS.filter((t) => audience === 'full' || !t.internal).filter((t) => routes.some((r) => tagFor(r.module, r.path) === t));
  doc.tags = [
    ...tagList.map((t) => ({
      name: t.name,
      description: `${t.description}\n\n_Release: ${t.release}._`,
    })),
    ...(externals.length ? [{ name: 'Health & Operations', description: 'Liveness/readiness probes, metrics and version metadata. No tenant context. **First call:** `getHealthLive`.' }] : []),
  ];
  doc['x-tagGroups'] = TAG_GROUPS.map((g) => ({
    name: g,
    tags: [
      ...tagList.filter((t) => t.group === g).map((t) => t.name),
      ...(g === 'Platform Control' && externals.length ? ['Health & Operations'] : []),
    ],
  })).filter((g) => g.tags.length);

  doc.webhooks = webhookDefinitions();
  describeAllProperties(doc);
  addExamples(doc, meta);
  addEnumCatalogNotes(doc);
  return doc;
}

function registerExternal(registry: OpenAPIRegistry, e: ExternalRoute) {
  registry.registerPath({
    method: e.method,
    path: openapiPath(e.path),
    operationId: e.operationId,
    summary: e.summary,
    description: e.description,
    tags: ['Health & Operations'],
    responses: Object.fromEntries(
      e.responses.map((x) => [x.status, { description: x.description, ...(x.schema ? { content: { [x.contentType ?? 'application/json']: { schema: x.schema } } } : {}) }]),
    ),
  } as never);
}

function patchExternal(doc: Json, e: ExternalRoute) {
  const op = doc.paths[openapiPath(e.path)]?.[e.method] as Json | undefined;
  if (!op) return;
  op.security = e.auth === 'none' ? [] : [{ bearerAuth: [] }];
  op['x-tenant-scoped'] = false;
  op['x-required-permission'] = null;
  op['x-audited'] = false;
  op['x-idempotent'] = false;
  op['x-rate-limit'] = 'none';
  op.description = `${e.description}\n\n| | |\n|---|---|\n| **Authentication** | ${e.auth === 'none' ? 'None (public)' : 'Bearer `METRICS_TOKEN`'} |\n| **Tenant scoped** | No |\n| **Rate limit** | Not rate limited |`;
  op.responses['500'] = { $ref: '#/components/responses/InternalError' };
  for (const [status, resp] of Object.entries(op.responses as Json)) {
    if (resp.$ref) continue;
    if (/^2/.test(status)) for (const m of Object.values((resp.content ?? {}) as Json) as Json[]) if (m.example === undefined) m.example = m.schema?.type === 'string' ? '# HELP process_cpu_user_seconds_total ...' : exampleFor(m.schema, doc);
    if (!/^[25]/.test(status[0]!)) continue;
    resp.headers = { 'X-Request-Id': { $ref: '#/components/headers/XRequestId' } };
    if (status === '503' || status === '429') resp.headers['Retry-After'] = { $ref: '#/components/headers/RetryAfter' };
  }
}

function sharedComponents(): Json {
  const errBody = (code: string, message: string, status: number, details: Json[] = []) => ({
    description: `${ERROR_CODES.find((c) => c.code === code)?.meaning ?? ''} (HTTP ${status})`.trim(),
    headers: {
      'X-Request-Id': { $ref: '#/components/headers/XRequestId' },
      ...(status === 429 || status === 503 ? { 'Retry-After': { $ref: '#/components/headers/RetryAfter' } } : {}),
    },
    content: {
      'application/json': {
        schema: { $ref: `#/components/schemas/${status === 422 ? 'ValidationErrorResponse' : 'ErrorResponse'}` },
        example: {
          errorMessage: [
            { id: 0, msg: message, msgType: 'Error', code },
            ...details.map((d: Json) => ({ id: 0, msg: d.field ? `${d.field}: ${d.issue}` : d.issue, msgType: 'Error', code, ...(d.field ? { field: d.field } : {}), issue: d.issue })),
          ],
          infoMessage: { id: 0, msg: null, msgType: 'Information' },
          hasError: true,
          requestId: DEMO.requestId,
        },
      },
    },
  });
  return {
    headers: {
      XRequestId: { description: 'Correlation id of this request. Quote it when contacting support. An inbound well-formed `X-Request-Id` is echoed.', schema: { type: 'string' }, example: DEMO.requestId },
      RetryAfter: { description: 'Seconds to wait before retrying.', schema: { type: 'integer' }, example: 30 },
      IdempotentReplay: { description: 'Present and `true` when the response is a stored replay of an earlier request with the same `Idempotency-Key`.', schema: { type: 'string', enum: ['true'] } },
      ETag: { description: 'Entity version (`rowVersion`) to send back as `If-Match`.', schema: { type: 'string' }, example: '"3"' },
      Deprecation: { description: '`true` when this API version is deprecated; see `Sunset`.', schema: { type: 'string' }, example: 'true' },
      Sunset: { description: 'HTTP-date after which the deprecated version is removed.', schema: { type: 'string' }, example: 'Wed, 30 Sep 2026 00:00:00 GMT' },
      ContentDisposition: { description: 'Suggested file name for downloads.', schema: { type: 'string' }, example: 'attachment; filename="invoice-INV-0001.pdf"' },
    },
    parameters: {
      IdempotencyKey: {
        name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string', maxLength: 128 }, example: '7b1c1c9e-6a3a-4e49-9c7b-2f1c5f3e9a10',
        description: 'Client-generated unique key (max 128 chars). Replaying the same key with the same body within 24 h returns the stored response (`Idempotent-Replay: true`); a different body returns `422 IDEMPOTENCY_KEY_REUSED`; while the first request is still running, `409`.',
      },
      IdempotencyKeyRequired: {
        name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', maxLength: 128 }, example: '7b1c1c9e-6a3a-4e49-9c7b-2f1c5f3e9a10',
        description: 'Client-generated unique key (max 128 chars) — **required** for this operation. Same key + same body replays the stored response for 24 h; a different body returns `422 IDEMPOTENCY_KEY_REUSED`.',
      },
      IfMatch: {
        name: 'If-Match', in: 'header', required: false, schema: { type: 'string' }, example: '"3"',
        description: 'The `rowVersion` you last read, optionally quoted. A stale or missing value returns `412 PRECONDITION_FAILED`. `rowVersion` in the body is accepted as an alternative.',
      },
      RequestId: {
        name: 'X-Request-Id', in: 'header', required: false, schema: { type: 'string', pattern: '^[\\w.-]{8,128}$' }, example: DEMO.requestId,
        description: 'Optional correlation id (8-128 chars of `[A-Za-z0-9._-]`). Echoed in the response and in logs/audit; generated when absent.',
      },
    },
    responses: {
      Unauthenticated: errBody('UNAUTHENTICATED', 'Authentication required', 401),
      PlanLimitExceeded: errBody('PLAN_LIMIT_EXCEEDED', 'Your plan does not include this feature', 402),
      Forbidden: errBody('FORBIDDEN', 'You do not have permission to perform this action', 403),
      NotFound: errBody('NOT_FOUND', 'Resource not found', 404),
      Conflict: errBody('CONFLICT', 'A resource with this value already exists', 409),
      PreconditionFailed: errBody('PRECONDITION_FAILED', 'The resource was modified by someone else; reload and retry', 412),
      ValidationFailed: errBody('VALIDATION_FAILED', 'Request validation failed', 422, [{ field: 'body.name', issue: 'Too small: expected string to have >=2 characters' }]),
      RateLimited: errBody('RATE_LIMITED', 'Too many requests', 429),
      InternalError: errBody('INTERNAL', 'Internal server error', 500),
      Maintenance: errBody('MAINTENANCE', 'The service is undergoing maintenance', 503),
    },
  };
}

function patchOperation(doc: Json, op: Json, r: AnyRoute, tag: TagDef) {
  const facts = inspectHandler(r);
  const hdr = (name: string) => ({ $ref: `#/components/parameters/${name}` });
  if (r.idempotent) op.parameters.push(hdr(r.idempotent === 'required' ? 'IdempotencyKeyRequired' : 'IdempotencyKey'));
  const concurrency = facts.usesIfMatch || (r.body && 'shape' in (r.body as object) && 'rowVersion' in (((r.body as z.ZodObject).shape ?? {}) as object));
  if (concurrency) op.parameters.push(hdr('IfMatch'));
  op.parameters.push(hdr('RequestId'));

  const okHeaders: Json = { 'X-Request-Id': { $ref: '#/components/headers/XRequestId' } };
  if (r.idempotent) okHeaders['Idempotent-Replay'] = { $ref: '#/components/headers/IdempotentReplay' };
  for (const [status, resp] of Object.entries(op.responses as Json)) {
    if (!/^2/.test(status)) continue;
    resp.headers = { ...okHeaders, ...(r.binary ? { 'Content-Disposition': { $ref: '#/components/headers/ContentDisposition' } } : {}) };
  }
  for (const status of errorStatuses(r)) {
    op.responses[String(status)] = { $ref: `#/components/responses/${ERROR_REF[status]}` };
  }
  for (const p of op.parameters as Json[]) {
    if (!p.name || p.$ref) continue;
    p.description ||= p.schema?.description ?? (p.in === 'path' ? paramDescription(p.name) : describeProperty(String(p.name)));
    if (p.example === undefined) p.example = p.schema?.example ?? p.schema?.enum?.[0] ?? p.schema?.default ?? (p.in === 'path' ? paramExample(p.name) : exampleFor(p.schema, doc, String(p.name)));
  }
  op['x-required-permission'] = permissionOf(r) ?? (r.access === 'platformAdmin' ? 'platform_admin' : null);
  op['x-tenant-scoped'] = scopeOf(r) === 'tenant';
  if (r.moduleFlag) op['x-feature-flag'] = r.moduleFlag;
  if (r.featureIds?.length) op['x-feature-ids'] = r.featureIds;
  op['x-audited'] = r.audit?.action ?? false;
  op['x-idempotent'] = r.idempotent === 'required' ? 'required' : r.idempotent ? 'optional' : false;
  op['x-rate-limit'] = r.rateLimit ?? 'default';
  if (r.asyncJob || successStatuses(r).includes(202)) op['x-async-job'] = true;
  op['x-release'] = tag.release;
  if (r.deprecated) op.deprecated = true;
}

/** Every object property gets a description (explicit ones are kept). */
function describeAllProperties(node: unknown, parentKey = ''): void {
  if (Array.isArray(node)) {
    node.forEach((n) => describeAllProperties(n, parentKey));
    return;
  }
  if (!node || typeof node !== 'object') return;
  const obj = node as Json;
  if (obj.properties && typeof obj.properties === 'object') {
    for (const [name, prop] of Object.entries(obj.properties as Json)) {
      if (prop && typeof prop === 'object' && !prop.description) prop.description = describeProperty(name);
    }
  }
  for (const [k, v] of Object.entries(obj)) describeAllProperties(v, k);
}

function addEnumCatalogNotes(doc: Json) {
  for (const [name, schema] of Object.entries((doc.components?.schemas ?? {}) as Json)) {
    if (!schema.description && !Array.isArray(schema.enum)) schema.description = humanize(name).replace(/^./, (ch: string) => ch.toUpperCase()) + '.';
    if (Array.isArray(schema.enum) && !schema.description) schema.description = `Allowed values for ${humanize(name)}: ${schema.enum.map((v: string) => `\`${v}\``).join(', ')}.`;
  }
}
