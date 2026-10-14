import type { Knex } from 'knex';
import type { Logger } from 'pino';

export type Trx = Knex.Transaction;

export interface TenantContext {
  organizationId: string;
  userId: string | null;
}

/** Tenant-scoped transaction: RLS sees only `organizationId` rows (plus the caller's own memberships). */
export function withTenant<T>(db: Knex, ctx: TenantContext, fn: (trx: Trx) => Promise<T>): Promise<T> {
  return db.transaction(async (trx) => {
    await trx.raw(`SELECT set_config('app.current_org', ?, true), set_config('app.current_user', ?, true)`, [
      ctx.organizationId,
      ctx.userId ?? '',
    ]);
    return fn(trx);
  });
}

/** User-scoped transaction (no organization): only the caller's own memberships are visible. */
export function withUser<T>(db: Knex, userId: string, fn: (trx: Trx) => Promise<T>): Promise<T> {
  return db.transaction(async (trx) => {
    await trx.raw(`SELECT set_config('app.current_user', ?, true)`, [userId]);
    return fn(trx);
  });
}

/**
 * Explicit, logged cross-tenant scope. Only for platform-admin routes, jobs and bootstrap flows.
 * The `reason` is mandatory and is written to the application log for every use.
 */
export function withPlatformScope<T>(
  db: Knex,
  reason: string,
  fn: (trx: Trx) => Promise<T>,
  log?: Logger,
): Promise<T> {
  log?.debug({ reason }, 'platform scope');
  return db.transaction(async (trx) => {
    await trx.raw(`SELECT set_config('app.platform', 'on', true)`);
    return fn(trx);
  });
}
