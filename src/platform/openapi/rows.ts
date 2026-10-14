import { z } from 'zod';
import { DB_ROWS } from './db-rows.generated.js';
import { describeProperty } from './describe.js';

const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

function column(kind: string): z.ZodType {
  const nullable = kind.endsWith('?');
  const base = nullable ? kind.slice(0, -1) : kind;
  let s: z.ZodType;
  switch (base) {
    case 'uuid': s = z.string().uuid(); break;
    case 'timestamp': s = z.string().openapi({ format: 'date-time' }); break;
    case 'date': s = z.string().openapi({ format: 'date', example: '2026-03-02' }); break;
    case 'boolean': s = z.boolean(); break;
    case 'integer': s = z.number().int(); break;
    case 'number': s = z.number(); break;
    case 'decimal': s = z.string().openapi({ description: 'Decimal value serialized as a string.', example: '1250.00' }); break;
    case 'stringArray': s = z.array(z.string()); break;
    case 'json': s = z.unknown(); break;
    default: s = z.string();
  }
  return nullable ? s.nullable() : s;
}

export interface RowOptions {
  /** Columns (snake_case) never returned by the API. */
  hide?: string[];
  /** Only these columns (snake_case). */
  only?: string[];
  /** Descriptions per camelCase property. */
  describe?: Record<string, string>;
  /** Extra / overriding properties. */
  extend?: Record<string, z.ZodType>;
}

/**
 * Response schema for a table row as `rowToApi()` returns it: camelCase keys, timestamps as ISO strings.
 * Derived from the migrated database (scripts/gen-db-schemas.ts) so it cannot disagree with the real columns.
 */
export function rowOf(table: string, opts: RowOptions = {}): z.ZodObject {
  const cols = DB_ROWS[table];
  if (!cols) throw new Error(`rowOf: unknown table "${table}" (run npm run docs:db-schemas)`);
  const shape: Record<string, z.ZodType> = {};
  for (const [name, kind] of Object.entries(cols)) {
    if (opts.hide?.includes(name)) continue;
    if (opts.only && !opts.only.includes(name)) continue;
    const key = camel(name);
    shape[key] = column(kind).describe(opts.describe?.[key] ?? describeProperty(key));
  }
  for (const [k, v] of Object.entries(opts.extend ?? {})) shape[k] = v;
  return z.object(shape);
}
