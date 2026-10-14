import { z, type ZodObject, type ZodRawShape } from 'zod';
import type { Knex } from 'knex';
import { defineRoute, type HandlerCtx } from './http/route.js';
import { AppError } from './errors.js';
import { newId } from './crypto.js';
import { listQuerySchema, paginate, type ListConfig, type ListQuery } from './pagination.js';
import type { Trx } from './scope.js';
import { humanize, pascal, singularize } from './openapi/naming-helpers.js';

export const toSnake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
export const toCamel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

export function rowToApi<T extends Record<string, unknown>>(row: T, hide: string[] = []): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (hide.includes(k)) continue;
    out[toCamel(k)] = v instanceof Date ? v.toISOString() : v;
  }
  return out;
}

export function inputToDb(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined) continue;
    out[toSnake(k)] = v !== null && typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v;
  }
  return out;
}

export interface CrudHooks<TIn = Record<string, unknown>> {
  beforeCreate?(c: HandlerCtx, trx: Trx, input: TIn): Promise<Record<string, unknown> | void>;
  beforeUpdate?(c: HandlerCtx, trx: Trx, input: Partial<TIn>, existing: Record<string, unknown>): Promise<Record<string, unknown> | void>;
  beforeDelete?(c: HandlerCtx, trx: Trx, existing: Record<string, unknown>): Promise<void>;
  afterCreate?(c: HandlerCtx, trx: Trx, row: Record<string, unknown>): Promise<void>;
  afterUpdate?(c: HandlerCtx, trx: Trx, row: Record<string, unknown>): Promise<void>;
  /** Extra scoping for reads/updates (e.g. only the caller's own rows). */
  scope?(c: HandlerCtx, qb: Knex.QueryBuilder): void;
}

export interface CrudConfig<S extends ZodRawShape> {
  module: string;
  path: string; // e.g. '/departments'
  table: string;
  resource: string; // permission prefix: `${resource}:read` ...
  moduleFlag?: string;
  create: ZodObject<S>;
  update?: ZodObject<ZodRawShape>; // defaults to create.partial()
  list: ListConfig;
  searchColumns?: string[];
  softDelete?: boolean;
  rowVersion?: boolean;
  hide?: string[];
  idempotentCreate?: boolean;
  /** Plan gating applied to the create route (billing module). */
  createEntitlement?: import('./entitlements.js').EntitlementSpec;
  hooks?: CrudHooks<z.infer<ZodObject<S>>>;
  /** Fixed filter columns applied to every query besides organization (e.g. status). */
  actions?: ('list' | 'get' | 'create' | 'update' | 'delete' | 'restore')[];
}

const idParams = z.object({ id: z.string().uuid() });

/** Registers list/get/create/update/delete(/restore) routes for a tenant-owned table. */
export function crudResource<S extends ZodRawShape>(cfg: CrudConfig<S>): void {
  const actions = cfg.actions ?? ['list', 'get', 'create', 'update', 'delete', ...(cfg.softDelete ? (['restore'] as const) : [])];
  const hide = cfg.hide ?? [];
  const base = (c: HandlerCtx, includeDeleted = false): Knex.QueryBuilder => {
    const qb = c.trx(cfg.table).where(`${cfg.table}.organization_id`, c.orgId()); // defense in depth over RLS
    if (cfg.softDelete && !includeDeleted) qb.whereNull(`${cfg.table}.deleted_at`);
    cfg.hooks?.scope?.(c, qb);
    return qb;
  };
  const last = cfg.path.split('/').filter(Boolean).pop() ?? cfg.resource;
  const plural = humanize(last);
  const one = humanize(singularize(last));
  const article = /^[aeiou]/.test(one) ? 'an' : 'a';
  const itemName = pascal(singularize(last));
  const itemSchema = z.object({
    id: z.string().uuid().describe('Unique identifier (UUID).'),
    ...Object.fromEntries(Object.entries(cfg.create.shape).map(([k, v]) => [k, (v as z.ZodType).optional()])),
    createdAt: z.string().describe('When the record was created (ISO-8601 UTC).'),
    updatedAt: z.string().describe('When the record was last changed (ISO-8601 UTC).'),
    createdBy: z.string().uuid().nullable().describe('User id that created the record.'),
    updatedBy: z.string().uuid().nullable().describe('User id that last changed the record.'),
    ...(cfg.rowVersion ? { rowVersion: z.number().int().describe('Optimistic-concurrency version; send it back as `rowVersion` or `If-Match` when updating.') } : {}),
    ...(cfg.softDelete ? { deletedAt: z.string().nullable().describe('When the record was soft-deleted (ISO-8601 UTC); `null` while active.') } : {}),
  }).loose();
  const listDocs = {
    sortable: Object.keys(cfg.list.sortable), filterable: Object.keys(cfg.list.filterable ?? {}),
    defaultSort: cfg.list.defaultSort, searchable: !!cfg.searchColumns?.length,
  };
  const common = { module: cfg.module, moduleFlag: cfg.moduleFlag, response: itemSchema, responseName: itemName } as const;
  const perm = (a: string) => ({ permission: `${cfg.resource}:${a}` });
  const requireVersion = (c: HandlerCtx, body: Record<string, unknown>): number | undefined => {
    if (!cfg.rowVersion) return undefined;
    const hdr = c.req.get('if-match')?.replace(/"/g, '');
    const v = hdr ? Number(hdr) : (body.rowVersion as number | undefined);
    if (v === undefined || !Number.isInteger(v)) {
      throw new AppError('PRECONDITION_FAILED', 'If-Match header or rowVersion is required');
    }
    return v;
  };

  if (actions.includes('list')) {
    defineRoute({
      ...common, method: 'get', path: cfg.path, summary: `List ${plural}`, access: perm('read'),
      query: listQuerySchema, list: listDocs,
      async handler(c) {
        const qb = base(c).select(`${cfg.table}.*`);
        const q = c.query as ListQuery;
        if (q.q && cfg.searchColumns?.length) {
          qb.where((w) => {
            for (const col of cfg.searchColumns!) w.orWhereILike(col, `%${q.q!.replace(/[%_\\]/g, '\\$&')}%`);
          });
        }
        const page = await paginate(qb, q, { ...cfg.list, idColumn: `${cfg.table}.id` });
        return { data: page.data.map((r) => rowToApi(r as Record<string, unknown>, hide)), meta: page.meta };
      },
    });
  }

  if (actions.includes('get')) {
    defineRoute({
      ...common, method: 'get', path: `${cfg.path}/:id`, summary: `Get ${article} ${one}`, access: perm('read'),
      params: idParams,
      async handler(c) {
        const row = await base(c).where(`${cfg.table}.id`, c.params.id).first();
        if (!row) throw new AppError('NOT_FOUND', 'Resource not found');
        return { data: rowToApi(row, hide) };
      },
    });
  }

  if (actions.includes('create')) {
    defineRoute({
      ...common, method: 'post', path: cfg.path, summary: `Create ${article} ${one}`, access: perm('create'),
      body: cfg.create, idempotent: cfg.idempotentCreate ? true : undefined, entitlement: cfg.createEntitlement,
      audit: { action: `${cfg.resource}.created`, resourceType: cfg.resource },
      async handler(c) {
        const input = c.body as Record<string, unknown>;
        const extra = (await cfg.hooks?.beforeCreate?.(c, c.trx, input as never)) ?? {};
        const id = newId();
        const row = {
          ...inputToDb(input), ...extra, id, organization_id: c.orgId(),
          created_by: c.auth!.userId, updated_by: c.auth!.userId,
        };
        try {
          await c.trx(cfg.table).insert(row);
        } catch (e) {
          throw mapDbError(e);
        }
        const created = await c.trx(cfg.table).where({ id }).first();
        await cfg.hooks?.afterCreate?.(c, c.trx, created);
        await c.emit(`${cfg.resource}.created`, { id });
        return { status: 201, data: rowToApi(created, hide) };
      },
    });
  }

  if (actions.includes('update')) {
    const schema = (cfg.update ?? cfg.create.partial()).extend({ rowVersion: z.number().int().optional() });
    defineRoute({
      ...common, method: 'patch', path: `${cfg.path}/:id`, summary: `Update ${article} ${one}`, access: perm('update'),
      params: idParams, body: schema, audit: { action: `${cfg.resource}.updated`, resourceType: cfg.resource },
      async handler(c) {
        const body = c.body as Record<string, unknown>;
        const expected = requireVersion(c, body);
        const { rowVersion: _rv, ...input } = body;
        void _rv;
        const existing = await base(c).where(`${cfg.table}.id`, c.params.id).forUpdate().first();
        if (!existing) throw new AppError('NOT_FOUND', 'Resource not found');
        if (expected !== undefined && existing.row_version !== expected) {
          throw new AppError('PRECONDITION_FAILED', 'The resource was modified by someone else; reload and retry');
        }
        const extra = (await cfg.hooks?.beforeUpdate?.(c, c.trx, input as never, existing)) ?? {};
        const patch: Record<string, unknown> = { ...inputToDb(input), ...extra, updated_by: c.auth!.userId, updated_at: c.svc.now() };
        if (cfg.rowVersion) patch.row_version = c.trx.raw('row_version + 1');
        try {
          await c.trx(cfg.table).where({ id: c.params.id, organization_id: c.orgId() }).update(patch);
        } catch (e) {
          throw mapDbError(e);
        }
        const row = await c.trx(cfg.table).where({ id: c.params.id }).first();
        await cfg.hooks?.afterUpdate?.(c, c.trx, row);
        await c.emit(`${cfg.resource}.updated`, { id: c.params.id });
        return { data: rowToApi(row, hide) };
      },
    });
  }

  if (actions.includes('delete')) {
    defineRoute({
      ...common, method: 'delete', path: `${cfg.path}/:id`, summary: `Delete ${article} ${one}`, access: perm('delete'),
      params: idParams, audit: { action: `${cfg.resource}.deleted`, resourceType: cfg.resource },
      async handler(c) {
        const existing = await base(c).where(`${cfg.table}.id`, c.params.id).forUpdate().first();
        if (!existing) throw new AppError('NOT_FOUND', 'Resource not found');
        await cfg.hooks?.beforeDelete?.(c, c.trx, existing);
        try {
          if (cfg.softDelete) {
            await c.trx(cfg.table).where({ id: c.params.id, organization_id: c.orgId() })
              .update({ deleted_at: c.svc.now(), deleted_by: c.auth!.userId });
          } else {
            await c.trx(cfg.table).where({ id: c.params.id, organization_id: c.orgId() }).delete();
          }
        } catch (e) {
          throw mapDbError(e);
        }
        await c.emit(`${cfg.resource}.deleted`, { id: c.params.id });
        return { status: 204, auditResourceId: c.params.id };
      },
    });
  }

  if (cfg.softDelete && actions.includes('restore')) {
    defineRoute({
      ...common, method: 'post', path: `${cfg.path}/:id/restore`, summary: `Restore ${article} ${one}`, access: perm('delete'),
      params: idParams, audit: { action: `${cfg.resource}.restored`, resourceType: cfg.resource },
      async handler(c) {
        const row = await base(c, true).where(`${cfg.table}.id`, c.params.id).whereNotNull(`${cfg.table}.deleted_at`).first();
        if (!row) throw new AppError('NOT_FOUND', 'Resource not found');
        try {
          await c.trx(cfg.table).where({ id: c.params.id }).update({ deleted_at: null, deleted_by: null });
        } catch (e) {
          throw mapDbError(e);
        }
        const restored = await c.trx(cfg.table).where({ id: c.params.id }).first();
        return { status: 200, data: rowToApi(restored, hide) };
      },
    });
  }
}

/** Maps Postgres constraint violations to clear API errors (never leaks SQL). */
export function mapDbError(e: unknown): unknown {
  const err = e as { code?: string; constraint?: string };
  if (err?.code === '23505') return new AppError('CONFLICT', 'A record with the same unique value already exists', [{ issue: err.constraint ?? 'duplicate' }]);
  if (err?.code === '23503') return new AppError('VALIDATION_FAILED', 'Referenced record does not exist or is in use', [{ issue: err.constraint ?? 'foreign_key' }]);
  if (err?.code === '23514') return new AppError('VALIDATION_FAILED', 'A value violates a constraint', [{ issue: err.constraint ?? 'check' }]);
  return e;
}
