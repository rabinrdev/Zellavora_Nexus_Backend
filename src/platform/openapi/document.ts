import { z } from 'zod';
import { routeRegistry, type AnyRoute } from '../http/route.js';

/** What a module may add to the routes it already registered (never behavior). */
export interface RouteDocs {
  /** Zod schema of the `data` member of the success response (or the array item for lists via `list`). */
  response?: z.ZodType;
  /** Component name of the item schema (`Project` → `Project`, `ProjectResponse`, `ProjectListResponse`). */
  responseName?: string;
  /** `response` describes one element and `data` is a plain array (non-paginated collection). */
  collection?: boolean;
  description?: string;
  successStatus?: number | number[];
  /** Additional documented success statuses are derived from the handler; use this for extra error statuses. */
  errors?: number[];
  requestExamples?: Record<string, unknown>;
  responseExample?: unknown;
  list?: NonNullable<AnyRoute['list']>;
  asyncJob?: boolean;
  featureIds?: string[];
  deprecated?: boolean;
}

/**
 * Attaches documentation to registered routes by operationId, so the contract lives next to the module but outside
 * the handler code. Throws at boot when an operationId is unknown (a rename cannot silently orphan its docs).
 */
export function documentRoutes(docs: Record<string, RouteDocs>): void {
  const byId = new Map(routeRegistry.map((r) => [r.operationId, r]));
  for (const [operationId, d] of Object.entries(docs)) {
    const r = byId.get(operationId);
    if (!r) throw new Error(`documentRoutes: unknown operationId "${operationId}"`);
    Object.assign(r, Object.fromEntries(Object.entries(d).filter(([, v]) => v !== undefined)));
  }
}

/** Frequently used building blocks for response schemas. */
export const uuid = z.string().uuid();
export const isoDate = z.string().openapi({ format: 'date-time', example: '2026-03-02T09:30:00.000Z', description: 'ISO-8601 UTC timestamp.' });
export const calendarDate = z.string().openapi({ format: 'date', example: '2026-03-02', description: 'Calendar date (`YYYY-MM-DD`).' });
export const messageResponse = z.object({ message: z.string().describe('Human-readable confirmation.') });
export const idResponse = z.object({ id: uuid.describe('Identifier of the affected resource.') });
export const decimal = z.string().openapi({ description: 'Decimal amount as a string, e.g. `"1250.00"`.', example: '1250.00' });
