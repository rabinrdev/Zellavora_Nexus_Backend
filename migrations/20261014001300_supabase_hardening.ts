import type { Knex } from 'knex';

/**
 * Managed-Postgres hardening (Supabase and similar):
 *  1. Platforms that auto-enable RLS on every new table would block our global (non-tenant) tables for the
 *     `nexus_app` role. Tenant tables (with organization_id) keep their explicit FORCE RLS policies; every other
 *     table gets RLS disabled again, matching the design in docs/TENANCY.md.
 *  2. Those platforms expose `public` through an HTTP data API for the `anon`/`authenticated` roles. This API is
 *     the only supported access path, so all privileges are revoked from those roles (no-op where they do not exist).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    DO $$
    DECLARE t record;
    BEGIN
      FOR t IN
        SELECT c.relname FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
         WHERE c.relkind = 'r' AND c.relrowsecurity
           AND NOT EXISTS (SELECT 1 FROM information_schema.columns k
                            WHERE k.table_schema = 'public' AND k.table_name = c.relname AND k.column_name = 'organization_id')
      LOOP
        EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', t.relname);
      END LOOP;

      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
        REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;
        REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon;
        ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon;
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        REVOKE ALL ON ALL TABLES IN SCHEMA public FROM authenticated;
        REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM authenticated;
        REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM authenticated;
        ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM authenticated;
      END IF;
    END $$;
  `);
}

export async function down(): Promise<void> {
  // Intentionally a no-op: re-enabling platform-default RLS or re-granting public API access would be unsafe.
}
