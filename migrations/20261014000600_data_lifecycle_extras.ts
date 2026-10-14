import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE import_jobs ADD COLUMN file_id uuid REFERENCES files(id);
    ALTER TABLE import_jobs ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
    ALTER TABLE deletion_requests ADD COLUMN confirmation text;
    CREATE INDEX idx_import_jobs_file ON import_jobs (file_id);
    GRANT SELECT ON knex_migrations TO nexus_app;
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE deletion_requests DROP COLUMN IF EXISTS confirmation;
    ALTER TABLE import_jobs DROP COLUMN IF EXISTS updated_at, DROP COLUMN IF EXISTS file_id;
  `);
}
