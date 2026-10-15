import knexLib, { type Knex } from 'knex';
import pg from 'pg';

// DATE columns are calendar dates, not instants: keep them as 'YYYY-MM-DD' strings (no timezone shifting).
pg.types.setTypeParser(1082, (v: string) => v);

/** Fail fast: an unreachable database must surface as an error within seconds, not as a gateway 504. */
export const DB_CONNECT_TIMEOUT_MS = 8_000;
const STATEMENT_TIMEOUT_MS = 25_000;

export function createDb(connectionString: string, poolMax = 10): Knex {
  return knexLib({
    client: 'pg',
    connection: { connectionString, connectionTimeoutMillis: DB_CONNECT_TIMEOUT_MS, statement_timeout: STATEMENT_TIMEOUT_MS },
    acquireConnectionTimeout: DB_CONNECT_TIMEOUT_MS + 2_000,
    pool: { min: 0, max: poolMax, idleTimeoutMillis: 10_000 },
  });
}

export { withTenant, withUser, withPlatformScope, type TenantContext } from '../platform/scope.js';
