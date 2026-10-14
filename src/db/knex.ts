import knexLib, { type Knex } from 'knex';
import pg from 'pg';

// DATE columns are calendar dates, not instants: keep them as 'YYYY-MM-DD' strings (no timezone shifting).
pg.types.setTypeParser(1082, (v: string) => v);

export function createDb(connectionString: string, poolMax = 10): Knex {
  return knexLib({ client: 'pg', connection: connectionString, pool: { min: 0, max: poolMax, idleTimeoutMillis: 10_000 } });
}

export { withTenant, withUser, withPlatformScope, type TenantContext } from '../platform/scope.js';
