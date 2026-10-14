/**
 * Fails (exit 1) if any table with an `organization_id` column lacks ENABLE + FORCE ROW LEVEL SECURITY
 * or a tenant_isolation policy. Run in CI after migrations.
 */
import 'dotenv/config';
import knexLib from 'knex';

const url = process.env.MIGRATOR_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error('MIGRATOR_DATABASE_URL or DATABASE_URL is required');
  process.exit(2);
}

// Global inbox/registry tables that deliberately carry no tenant column semantics.
const ALLOW = new Set<string>([]);

const db = knexLib({ client: 'pg', connection: url });
const rows = (await db.raw(
  `SELECT c.relname AS table, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
          EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname AND p.policyname = 'tenant_isolation') AS has_policy
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
    WHERE c.relkind = 'r'
      AND EXISTS (SELECT 1 FROM information_schema.columns k WHERE k.table_schema = 'public' AND k.table_name = c.relname AND k.column_name = 'organization_id')
    ORDER BY c.relname`,
)).rows as { table: string; enabled: boolean; forced: boolean; has_policy: boolean }[];

const bad = rows.filter((r) => !ALLOW.has(r.table) && (!r.enabled || !r.forced || !r.has_policy));
for (const r of rows) {
  const ok = r.enabled && r.forced && r.has_policy;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${r.table}`);
}
await db.destroy();
if (bad.length) {
  console.error(`\n${bad.length} tenant table(s) without enforced RLS: ${bad.map((b) => b.table).join(', ')}`);
  process.exit(1);
}
console.log(`\nRLS audit passed: ${rows.length} tenant-owned tables`);
