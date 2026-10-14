import type { Knex } from 'knex';
import { enableTenantRls, grantApp } from '../src/db/migration-helpers.js';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    -- metadata only (route, status, duration, client, request id): never bodies, headers or query strings
    CREATE TABLE api_request_audit (
      id uuid PRIMARY KEY,
      organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
      client_id uuid, route text NOT NULL, method text NOT NULL, status int NOT NULL, duration_ms int NOT NULL,
      request_id text, occurred_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX idx_api_request_audit_org_time ON api_request_audit (organization_id, occurred_at DESC);
    CREATE INDEX idx_api_request_audit_client ON api_request_audit (client_id, occurred_at DESC);

    -- trigram indexes for the global search endpoint
    CREATE INDEX idx_projects_name_trgm ON projects USING gin (name gin_trgm_ops);
    CREATE INDEX idx_tasks_title_trgm ON tasks USING gin (title gin_trgm_ops);
    CREATE INDEX idx_leads_name_trgm ON leads USING gin (name gin_trgm_ops);
    CREATE INDEX idx_contacts_name_trgm ON contacts USING gin (name gin_trgm_ops);
    CREATE INDEX idx_billing_customers_name_trgm ON billing_customers USING gin (name gin_trgm_ops);
  `);
  await enableTenantRls(knex, 'api_request_audit', { orgNullable: true });
  await grantApp(knex, ['api_request_audit'], 'SELECT, INSERT');
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    DROP INDEX IF EXISTS idx_billing_customers_name_trgm, idx_contacts_name_trgm, idx_leads_name_trgm, idx_tasks_title_trgm, idx_projects_name_trgm;
    DROP TABLE IF EXISTS api_request_audit;
  `);
}
