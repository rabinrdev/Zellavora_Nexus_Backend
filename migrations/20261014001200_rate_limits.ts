import type { Knex } from 'knex';

/** Shared counters for the Postgres rate limiter (multi-instance deployments). No tenant data. */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE rate_limits (
      key varchar(255) PRIMARY KEY,
      points integer NOT NULL DEFAULT 0,
      expire bigint
    );
    CREATE INDEX idx_rate_limits_expire ON rate_limits (expire);
    GRANT SELECT, INSERT, UPDATE, DELETE ON rate_limits TO nexus_app;
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP TABLE IF EXISTS rate_limits');
}
