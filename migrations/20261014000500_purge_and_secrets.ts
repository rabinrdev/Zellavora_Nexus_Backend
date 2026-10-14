import type { Knex } from 'knex';
import { enableTenantRls, grantApp } from '../src/db/migration-helpers.js';

export async function up(knex: Knex): Promise<void> {
  // Append-only guard: UPDATE always blocked; DELETE only inside the audited privileged purge functions below.
  await knex.raw(`
    CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      IF TG_OP = 'DELETE' AND current_setting('nexus.purge', true) = 'on' THEN
        RETURN OLD;
      END IF;
      RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
    END
    $fn$;

    -- Retention: delete audit events older than a cutoff for one organization. SECURITY DEFINER (owner bypasses RLS);
    -- records its own audit row so the purge itself is traceable.
    CREATE OR REPLACE FUNCTION purge_audit_events(p_org uuid, p_before timestamptz) RETURNS bigint
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
    DECLARE n bigint;
    BEGIN
      PERFORM set_config('nexus.purge', 'on', true);
      DELETE FROM audit_events WHERE organization_id = p_org AND occurred_at < p_before;
      GET DIAGNOSTICS n = ROW_COUNT;
      PERFORM set_config('nexus.purge', 'off', true);
      INSERT INTO audit_events (id, organization_id, actor_type, action, resource_type, outcome, metadata)
      VALUES (gen_random_uuid(), p_org, 'system', 'audit.retention_purged', 'audit_events', 'success',
              jsonb_build_object('deleted', n, 'before', p_before));
      RETURN n;
    END
    $fn$;

    -- Irreversible tenant deletion: removes every row carrying the organization id (dependency-ordered by retry),
    -- then the organization. Used only by the deletion-request job after the grace period.
    CREATE OR REPLACE FUNCTION purge_organization(p_org uuid) RETURNS int
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
    DECLARE
      t record; pass int := 0; remaining int; done boolean := false;
    BEGIN
      PERFORM set_config('nexus.purge', 'on', true);
      WHILE NOT done AND pass < 12 LOOP
        pass := pass + 1; remaining := 0;
        FOR t IN SELECT c.table_name FROM information_schema.columns c
                  JOIN information_schema.tables tb ON tb.table_name = c.table_name AND tb.table_schema = c.table_schema
                 WHERE c.table_schema = 'public' AND c.column_name = 'organization_id' AND tb.table_type = 'BASE TABLE'
                   AND c.table_name <> 'organizations'
        LOOP
          BEGIN
            EXECUTE format('DELETE FROM %I WHERE organization_id = $1', t.table_name) USING p_org;
          EXCEPTION WHEN foreign_key_violation THEN
            remaining := remaining + 1;
          END;
        END LOOP;
        BEGIN
          DELETE FROM organizations WHERE id = p_org;
          done := true;
        EXCEPTION WHEN foreign_key_violation THEN
          remaining := remaining + 1;
        END;
      END LOOP;
      PERFORM set_config('nexus.purge', 'off', true);
      IF NOT done THEN RAISE EXCEPTION 'organization purge incomplete'; END IF;
      RETURN pass;
    END
    $fn$;
    REVOKE ALL ON FUNCTION purge_audit_events(uuid, timestamptz) FROM PUBLIC;
    REVOKE ALL ON FUNCTION purge_organization(uuid) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION purge_audit_events(uuid, timestamptz) TO nexus_app;
    GRANT EXECUTE ON FUNCTION purge_organization(uuid) TO nexus_app;

    CREATE TABLE secret_references (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      name text NOT NULL, provider text NOT NULL DEFAULT 'env', version int NOT NULL DEFAULT 1,
      rotated_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (organization_id, name)
    );
  `);
  await enableTenantRls(knex, 'secret_references');
  await grantApp(knex, ['secret_references']);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    DROP TABLE IF EXISTS secret_references;
    DROP FUNCTION IF EXISTS purge_organization(uuid);
    DROP FUNCTION IF EXISTS purge_audit_events(uuid, timestamptz);
    CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
    END
    $fn$;
  `);
}
