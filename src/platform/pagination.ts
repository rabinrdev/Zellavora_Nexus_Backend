import { z } from 'zod';
import type { Knex } from 'knex';
import { AppError } from './errors.js';

export interface ListConfig {
  /** API field name -> SQL column. Only these may be sorted. */
  sortable: Record<string, string>;
  /** API field name -> SQL column. Only these may be filtered (equality / `in` via comma list). */
  filterable?: Record<string, string>;
  defaultSort: string; // e.g. '-created_at'
  idColumn?: string;
}

export const listQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().max(512).optional(),
    page: z.coerce.number().int().min(1).optional(),
    pageSize: z.coerce.number().int().min(1).max(100).optional(),
    sort: z.string().max(64).optional(),
    q: z.string().max(200).optional(),
    /** `only` lists soft-deleted rows (trash) for resources that support restore; needs the resource delete permission. */
    deleted: z.enum(['only']).optional(),
    filter: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
  })
  .loose();
export type ListQuery = z.infer<typeof listQuerySchema>;

interface Cursor {
  v: string | number | null;
  id: string;
}
const enc = (c: Cursor) => Buffer.from(JSON.stringify(c)).toString('base64url');
function dec(s: string): Cursor {
  try {
    const c = JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as Cursor;
    if (typeof c?.id !== 'string') throw new Error();
    return c;
  } catch {
    throw new AppError('VALIDATION_FAILED', 'Invalid cursor', [{ field: 'cursor', issue: 'malformed' }]);
  }
}

export interface Page<T> {
  data: T[];
  meta: { limit: number; nextCursor: string | null; total?: number; page?: number; pageSize?: number };
}

/**
 * Applies whitelist filters + stable sort (tie-break on id) + cursor (keyset) or offset pagination.
 * Unknown sort/filter fields are rejected with 422.
 */
export async function paginate<T extends Record<string, unknown>>(
  qb: Knex.QueryBuilder,
  q: ListQuery,
  cfg: ListConfig,
): Promise<Page<T>> {
  const idCol = cfg.idColumn ?? 'id';
  const sortSpec = q.sort ?? cfg.defaultSort;
  const desc = sortSpec.startsWith('-');
  const field = sortSpec.replace(/^[-+]/, '');
  const col = cfg.sortable[field];
  if (!col) throw new AppError('VALIDATION_FAILED', 'Invalid sort field', [{ field: 'sort', issue: `unknown field "${field}"` }]);

  for (const [k, raw] of Object.entries(q.filter ?? {})) {
    const fcol = cfg.filterable?.[k];
    if (!fcol) throw new AppError('VALIDATION_FAILED', 'Invalid filter field', [{ field: `filter[${k}]`, issue: 'not filterable' }]);
    const vals = Array.isArray(raw) ? raw : raw.split(',');
    qb.whereIn(fcol, vals);
  }

  const dir = desc ? 'desc' : 'asc';
  const offsetMode = q.page !== undefined;
  const limit = offsetMode ? (q.pageSize ?? q.limit) : q.limit;

  let total: number | undefined;
  if (offsetMode) {
    const row = await qb.clone().clearSelect().clearOrder().count({ c: '*' }).first();
    total = Number((row as { c: string | number } | undefined)?.c ?? 0);
  }

  qb.orderBy(col, dir).orderBy(idCol, dir);

  if (!offsetMode && q.cursor) {
    const c = dec(q.cursor);
    const op = desc ? '<' : '>';
    qb.whereRaw(`(??, ??) ${op} (?, ?)`, [col, idCol, c.v, c.id]);
  }
  if (offsetMode) qb.offset(((q.page ?? 1) - 1) * limit);

  const rows = (await qb.limit(limit + 1)) as T[];
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const last = data[data.length - 1];
  const sortKey = col.includes('.') ? col.split('.').pop()! : col;
  const nextCursor =
    !offsetMode && hasMore && last
      ? enc({ v: (last[sortKey] as string | number | null) ?? null, id: String(last[idCol.split('.').pop()!]) })
      : null;

  return {
    data,
    meta: { limit, nextCursor, ...(total !== undefined ? { total, page: q.page, pageSize: limit } : {}) },
  };
}
