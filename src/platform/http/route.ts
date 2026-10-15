import '../openapi/zod-extend.js';
import type { Request, Response, Router } from 'express';
import type { ZodType, z } from 'zod';
import { createHash } from 'node:crypto';
import multer from 'multer';
import { AppError } from '../errors.js';
import type { AuthContext, Services } from '../types.js';
import { withPlatformScope, withTenant, withUser, type Trx } from '../scope.js';
import { recordAudit, recordSecurityEvent, type AuditInput, type RequestMeta } from '../audit.js';
import { authenticate } from './authn.js';
import { isFlagEnabled } from '../flags.js';
import { newId } from '../crypto.js';
import { assertPlanAllows } from '../entitlements.js';
import type { BucketName } from '../rate-limit.js';
import { OPERATION_IDS } from '../openapi/operations.js';
import { describeParamNames } from '../openapi/naming.js';
import { successBody } from './envelope.js';

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

export interface HandlerCtx<P = unknown, Q = unknown, B = unknown> {
  params: P;
  query: Q;
  body: B;
  auth: AuthContext | null;
  /** Transaction already scoped (tenant / user / platform) per the route's `scope`. */
  trx: Trx;
  svc: Services;
  requestId: string;
  ip: string | null;
  userAgent: string | null;
  req: Request;
  res: Response;
  meta: RequestMeta;
  audit(input: AuditInput): Promise<void>;
  emit(type: string, payload: Record<string, unknown>): Promise<void>;
  /** Org id of the caller. Throws if the route is not tenant-scoped. */
  orgId(): string;
}

export interface HandlerResult {
  status?: number;
  data?: unknown;
  meta?: Record<string, unknown>;
  /** Shown to the user as `infoMessage.msg`. */
  message?: string;
  headers?: Record<string, string>;
  /** Binary/text body instead of the JSON envelope (e.g. PDF, CSV, file download). */
  raw?: { contentType: string; body: Buffer | string; filename?: string };
  auditResourceId?: string;
  /** Raised after the transaction commits (lockout counters, security events must persist even when the request fails). */
  errorAfterCommit?: AppError;
}

export interface RouteDef<P extends ZodType = ZodType, Q extends ZodType = ZodType, B extends ZodType = ZodType> {
  method: HttpMethod;
  path: string; // relative to /api/v1, express-style (:id)
  module: string;
  summary: string;
  /** public = no auth; authenticated = any signed-in user; permission string = RBAC-checked. */
  access: 'public' | 'authenticated' | 'platformAdmin' | { permission: string };
  scope?: 'tenant' | 'user' | 'platform';
  /** Handler never touches the database: skip the transaction (`ctx.trx` is unusable), so it works when the DB is down. */
  stateless?: boolean;
  /** Success body is `data` itself, not the JSON envelope (wire contract fixed by an existing client, e.g. `gettoken`). */
  bare?: boolean;
  params?: P;
  query?: Q;
  body?: B;
  response?: ZodType;
  audit?: { action: string; resourceType?: string };
  idempotent?: boolean | 'required';
  rateLimit?: BucketName;
  moduleFlag?: string;
  allowSuspendedTenant?: boolean;
  /** Session still needs MFA enrolment/verification; only MFA endpoints set this. */
  allowPendingMfa?: boolean;
  /** Returns a non-JSON body (file/PDF/CSV). */
  binary?: boolean;
  /** Plan gating (billing module): boolean feature and/or numeric limit. Skipped when module.billing is off. */
  entitlement?: { key: string; count?: (c: { trx: Trx; orgId: string }) => Promise<number> };
  /** multipart/form-data single-file upload; the file is available as `ctx.req.file`. */
  upload?: { field: string; maxBytes?: number };
  /** Frontend-facing name; assigned from the operation catalog (src/platform/openapi/operations.ts) when omitted. */
  operationId?: string;
  /** Markdown description for the API docs (purpose, business rules, side effects). */
  description?: string;
  /** Documented success status when the handler returns something other than the default (POST 201, otherwise 200). */
  successStatus?: number | number[];
  /** Extra documented error statuses beyond those derived from access/params/body/idempotency. */
  errors?: number[];
  /** Feature ids from the product plan (traceability), e.g. ['F-063']. */
  featureIds?: string[];
  /** Named request-body examples (the first is the default). */
  requestExamples?: Record<string, unknown>;
  /** Example of the `data` member of the success response. */
  responseExample?: unknown;
  /** Documented as an asynchronous operation: returns 202 and a job/export to poll. */
  asyncJob?: boolean;
  /** Request content type when it is not JSON (multipart is implied by `upload`). */
  contentType?: 'application/json' | 'multipart/form-data' | 'text/csv';
  /** List metadata mirrored into the docs: whitelisted sort/filter fields (generated from the same config the code enforces). */
  list?: { sortable: string[]; filterable: string[]; defaultSort: string; searchable?: boolean };
  /** `response` describes one element; `data` is an array of them (non-paginated collection). */
  collection?: boolean;
  /** Component name of the item schema in `response` (e.g. `Project`); the docs register `Project`, `ProjectResponse`, `ProjectListResponse`. */
  responseName?: string;
  /** Component name for the request body schema; defaults to `<OperationId>Request`. */
  requestName?: string;
  /** Documented as deprecated; name the replacement in `description`. */
  deprecated?: boolean;
  /** Set by defineRoute: exposed path parameter name → internal name read by the handler/schema (`projectId` → `id`). */
  paramAliases?: Record<string, string>;
  /** Set by defineRoute: the `METHOD /path` key used in the catalog (path before param renaming). */
  catalogKey?: string;
  handler(ctx: HandlerCtx<z.infer<P>, z.infer<Q>, z.infer<B>>): Promise<HandlerResult | void>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyRoute = RouteDef<any, any, any>;
export const routeRegistry: AnyRoute[] = [];

export function defineRoute<P extends ZodType, Q extends ZodType, B extends ZodType>(
  def: RouteDef<P, Q, B>,
): RouteDef<P, Q, B> {
  // frontend-facing names: `:id` becomes `:projectId` etc.; handlers keep reading `params.id` (see handle())
  def.catalogKey = `${def.method.toUpperCase()} ${def.path}`;
  def.operationId ??= OPERATION_IDS[def.catalogKey];
  const aliases = describeParamNames(def.path);
  if (Object.keys(aliases).length) {
    let renamed = def.path;
    for (const [exposed, internal] of Object.entries(aliases)) renamed = renamed.replace(new RegExp(`:${internal}(?=/|$)`), `:${exposed}`);
    def.paramAliases = aliases;
    def.path = renamed;
  }
  routeRegistry.push(def as AnyRoute);
  return def;
}

export function permissionOf(def: AnyRoute): string | null {
  return typeof def.access === 'object' ? def.access.permission : null;
}

function parse<T extends ZodType>(schema: T | undefined, value: unknown, where: string): z.infer<T> | undefined {
  if (!schema) return undefined;
  const r = schema.safeParse(value ?? {});
  if (!r.success) {
    throw new AppError(
      'VALIDATION_FAILED',
      'Request validation failed',
      r.error.issues.map((i) => ({ field: [where, ...i.path].filter(Boolean).join('.'), issue: i.message })),
    );
  }
  return r.data;
}

export function mountRoutes(router: Router, svc: Services, routes: AnyRoute[] = routeRegistry): void {
  for (const def of routes) {
    router[def.method](def.path, async (req, res, next) => {
      try {
        await handle(def, svc, req, res);
      } catch (e) {
        next(e);
      }
    });
  }
}

async function handle(def: AnyRoute, svc: Services, req: Request, res: Response): Promise<void> {
  const requestId = res.locals.requestId as string;
  const ip = req.ip ?? null;
  const userAgent = req.get('user-agent') ?? null;
  const limiter = res.app.locals.rateLimiter as import('../rate-limit.js').RateLimiter;

  // 1. rate limit (per-IP always; per-route bucket stricter on sensitive endpoints)
  await limiter.consume(def.rateLimit ?? 'default', ip);

  // 2. authentication
  let auth: AuthContext | null = null;
  if (def.access !== 'public') {
    auth = await authenticate(svc, req, {
      allowSuspendedTenant: def.allowSuspendedTenant,
      allowPendingMfa: def.allowPendingMfa,
    });
    if (auth.realm === 'apikey') res.locals.apiClient = { id: auth.apiKeyId, organizationId: auth.organizationId };
    if (def.access === 'platformAdmin' && !auth.isPlatformAdmin) throw new AppError('FORBIDDEN', 'Forbidden');
    if (typeof def.access === 'object' && !auth.permissions.has(def.access.permission)) {
      await withPlatformScope(svc.db, 'security-event', (t) =>
        recordSecurityEvent(
          t,
          { organizationId: auth!.organizationId, actorId: auth!.userId, correlationId: requestId, ip, userAgent },
          'permission_denied',
          'denied',
          { permission: def.access && typeof def.access === 'object' ? def.access.permission : null, route: def.path },
        ),
      );
      throw new AppError('FORBIDDEN', 'You do not have permission to perform this action');
    }
    if (def.scope !== 'user' && def.scope !== 'platform' && def.access !== 'platformAdmin' && !auth.organizationId) {
      throw new AppError('FORBIDDEN', 'An active organization is required');
    }
    await limiter.consume(def.rateLimit ?? 'default', `u:${auth.userId}`, auth.organizationId ? `o:${auth.organizationId}` : null);
  }

  // 3. module flag
  if (def.moduleFlag && !(await isFlagEnabled(svc.db, def.moduleFlag, { organizationId: auth?.organizationId, userId: auth?.userId }))) {
    throw new AppError('NOT_FOUND', 'Resource not found');
  }

  // 4. validation (client-supplied organization ids are never read: schemas strip unknown keys)
  if (def.upload) {
    await new Promise<void>((resolve, reject) => {
      multer({ storage: multer.memoryStorage(), limits: { fileSize: def.upload!.maxBytes ?? svc.env.MAX_UPLOAD_BYTES, files: 1 } })
        .single(def.upload!.field)(req, res, (err: unknown) => {
          if (!err) return resolve();
          const code = (err as { code?: string }).code;
          reject(new AppError('VALIDATION_FAILED', code === 'LIMIT_FILE_SIZE' ? 'File is too large' : 'Invalid upload', [{ field: def.upload!.field, issue: code ?? 'invalid' }]));
        });
    });
  }
  const rawParams: Record<string, unknown> = { ...req.params };
  for (const [exposed, internal] of Object.entries(def.paramAliases ?? {})) {
    rawParams[internal] = rawParams[exposed];
    delete rawParams[exposed];
  }
  const params = parse(def.params, rawParams, 'params');
  const query = parse(def.query, req.query, 'query');
  const body = parse(def.body, req.body, 'body');

  // 5. idempotency
  let idemKey: string | null = null;
  let idemId: string | null = null;
  if (def.idempotent) {
    idemKey = req.get('idempotency-key') ?? null;
    if (!idemKey && def.idempotent === 'required') {
      throw new AppError('VALIDATION_FAILED', 'Idempotency-Key header is required', [
        { field: 'Idempotency-Key', issue: 'required' },
      ]);
    }
    if (idemKey) {
      if (idemKey.length > 128) throw new AppError('VALIDATION_FAILED', 'Idempotency-Key too long');
      const hash = createHash('sha256').update(`${req.method}:${req.originalUrl}:${JSON.stringify(req.body ?? {})}`).digest('hex');
      const scopeId = auth?.organizationId ?? auth?.userId ?? `ip:${ip}`;
      const route = `${def.method.toUpperCase()} ${def.path}`;
      const replay = await withPlatformScope(svc.db, 'idempotency', async (t) => {
        const id = newId();
        const ins = await t('idempotency_records')
          .insert({
            id, organization_id: auth?.organizationId ?? null, scope_id: scopeId, key: idemKey, route,
            request_hash: hash, expires_at: new Date(Date.now() + 24 * 3600 * 1000),
          })
          .onConflict(['scope_id', 'key', 'route'])
          .ignore()
          .returning('id');
        if (ins.length > 0) return { kind: 'new' as const, id };
        const row = await t('idempotency_records').where({ scope_id: scopeId, key: idemKey, route }).first();
        if (row.request_hash !== hash) throw new AppError('IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key reused with a different request');
        if (row.state !== 'done') throw new AppError('CONFLICT', 'A request with this Idempotency-Key is in progress');
        return { kind: 'replay' as const, status: row.response_status as number, body: row.response_body };
      });
      if (replay.kind === 'replay') {
        res.setHeader('Idempotent-Replay', 'true');
        res.status(replay.status).json(replay.body);
        return;
      }
      idemId = replay.id;
    }
  }

  // 6. run inside a correctly scoped transaction
  const scope = def.scope ?? (def.access === 'public' || def.access === 'platformAdmin' ? 'platform' : 'tenant');
  const meta: RequestMeta = {
    organizationId: scope === 'tenant' ? auth?.organizationId ?? null : null,
    actorId: auth?.userId ?? null,
    actorType: auth?.realm === 'apikey' ? 'api_key' : 'user',
    correlationId: requestId,
    ip,
    userAgent,
  };

  // support-access sessions are strictly read-only and every request leaves a trail in the tenant's security log
  if (auth?.realm === 'support' && def.method !== 'get') throw new AppError('FORBIDDEN', 'Support access is read-only');

  const exec = async (trx: Trx): Promise<HandlerResult> => {
    if (auth?.organizationId && scope === 'tenant') {
      await assertPlanAllows(trx, auth.organizationId, { method: req.method, module: def.module, entitlement: def.entitlement });
      if (auth.realm === 'support') {
        await recordSecurityEvent(trx, { organizationId: auth.organizationId, actorId: auth.userId, correlationId: requestId, ip, userAgent }, 'support_access', 'success', { route: def.path, actor: 'platform_support' });
      }
    }
    const ctx: HandlerCtx = {
      params, query, body, auth, trx, svc, requestId, ip, userAgent, req, res, meta,
      audit: (input) => recordAudit(trx, meta, input),
      emit: (type, payload) => svc.events.emit(trx, type, meta.organizationId, payload, requestId),
      orgId: () => {
        if (!auth?.organizationId) throw new AppError('FORBIDDEN', 'An active organization is required');
        return auth.organizationId;
      },
    };
    const result = (await def.handler(ctx)) ?? {};
    if (def.audit) {
      const data = result.data as { id?: string } | undefined;
      await recordAudit(trx, meta, {
        action: def.audit.action,
        resourceType: def.audit.resourceType,
        resourceId: result.auditResourceId ?? data?.id,
      });
    }
    return result;
  };

  let result: HandlerResult;
  try {
    if (def.stateless) {
      result = await exec(undefined as unknown as Trx);
    } else if (scope === 'tenant') {
      if (!auth?.organizationId) throw new AppError('FORBIDDEN', 'An active organization is required');
      result = await withTenant(svc.db, { organizationId: auth.organizationId, userId: auth.userId }, exec);
    } else if (scope === 'user') {
      if (!auth) throw new AppError('UNAUTHENTICATED', 'Authentication required');
      result = await withUser(svc.db, auth.userId, exec);
    } else {
      result = await withPlatformScope(svc.db, `route:${def.method} ${def.path}`, exec, svc.log);
    }
  } catch (e) {
    if (idemId) await withPlatformScope(svc.db, 'idempotency', (t) => t('idempotency_records').where({ id: idemId }).delete());
    throw e;
  }

  if (result.errorAfterCommit) {
    if (idemId) await withPlatformScope(svc.db, 'idempotency', (t) => t('idempotency_records').where({ id: idemId }).delete());
    throw result.errorAfterCommit;
  }

  // 7. respond
  const status = result.status ?? (def.method === 'post' ? 201 : 200);
  for (const [k, v] of Object.entries(result.headers ?? {})) res.setHeader(k, v);
  if (result.raw) {
    res.setHeader('Content-Type', result.raw.contentType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (result.raw.filename) res.setHeader('Content-Disposition', `attachment; filename="${result.raw.filename.replace(/[^\w.-]/g, '_')}"`);
    res.status(status).send(result.raw.body);
    return;
  }
  const payload = status === 204 ? undefined : def.bare ? result.data : successBody(result.data, { meta: result.meta, message: result.message });
  if (idemId) {
    await withPlatformScope(svc.db, 'idempotency', (t) =>
      t('idempotency_records').where({ id: idemId }).update({
        state: 'done', response_status: status, response_body: payload ? JSON.stringify(payload) : null,
      }),
    );
  }
  if (status === 204) res.status(204).end();
  else res.status(status).json(payload);
}
