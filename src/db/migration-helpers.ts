import type { Knex } from 'knex';

/**
 * Enables FORCE RLS on a tenant-owned table.
 * - tenant policy: organization_id = app.current_org
 * - platform policy: app.platform = 'on' (set only by withPlatformScope(), which is audited)
 * `orgNullable` lets rows with a NULL organization (system roles, global events) be read by every tenant.
 */
export async function enableTenantRls(knex: Knex, table: string, opts: { orgNullable?: boolean } = {}): Promise<void> {
  const cur = `nullif(current_setting('app.current_org', true), '')::uuid`;
  await knex.raw(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
  const using = opts.orgNullable ? `organization_id IS NULL OR organization_id = ${cur}` : `organization_id = ${cur}`;
  await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON ${table}`);
  await knex.raw(
    `CREATE POLICY tenant_isolation ON ${table} USING (${using}) WITH CHECK (organization_id = ${cur})`,
  );
  await knex.raw(`DROP POLICY IF EXISTS platform_scope ON ${table}`);
  await knex.raw(
    `CREATE POLICY platform_scope ON ${table} USING (current_setting('app.platform', true) = 'on')
       WITH CHECK (current_setting('app.platform', true) = 'on')`,
  );
}

export async function appendOnly(knex: Knex, table: string): Promise<void> {
  await knex.raw(
    `CREATE TRIGGER trg_${table}_append_only BEFORE UPDATE OR DELETE ON ${table}
       FOR EACH ROW EXECUTE FUNCTION forbid_mutation()`,
  );
}

export async function grantApp(knex: Knex, tables: string[], privileges = 'SELECT, INSERT, UPDATE, DELETE'): Promise<void> {
  for (const t of tables) await knex.raw(`GRANT ${privileges} ON ${t} TO nexus_app`);
}
