import type { Knex } from 'knex';

const TENANT_TABLES = ['organization_memberships', 'audit_events'];

export async function up(knex: Knex): Promise<void> {
  await knex.raw('CREATE EXTENSION IF NOT EXISTS pgcrypto');
  await knex.raw('CREATE EXTENSION IF NOT EXISTS citext');
  await knex.raw('CREATE EXTENSION IF NOT EXISTS pg_trgm');

  // Non-owner, non-superuser runtime role: FORCE RLS applies to it.
  const pw = (process.env.NEXUS_APP_DB_PASSWORD ?? 'nexus_app_dev_pw').replace(/'/g, "''");
  await knex.raw(
    `DO $$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexus_app') THEN
         CREATE ROLE nexus_app LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${pw}';
       END IF;
     END $$`,
  );

  await knex.raw(`
    CREATE TABLE users (
      id uuid PRIMARY KEY,
      email citext NOT NULL UNIQUE,
      name text NOT NULL,
      status text NOT NULL DEFAULT 'active' CONSTRAINT ck_users_status CHECK (status IN ('active','deactivated')),
      email_verified_at timestamptz,
      locale text NOT NULL DEFAULT 'en',
      timezone text NOT NULL DEFAULT 'UTC',
      password_hash text,
      password_changed_at timestamptz,
      failed_login_count int NOT NULL DEFAULT 0,
      locked_until timestamptz,
      permission_version int NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE organizations (
      id uuid PRIMARY KEY,
      name text NOT NULL,
      code citext NOT NULL UNIQUE,
      slug citext NOT NULL UNIQUE,
      type text NOT NULL DEFAULT 'business' CONSTRAINT ck_organizations_type CHECK (type IN ('business','personal')),
      status text NOT NULL DEFAULT 'active'
        CONSTRAINT ck_organizations_status CHECK (status IN ('pending','active','suspended','closed')),
      timezone text NOT NULL DEFAULT 'UTC',
      locale text NOT NULL DEFAULT 'en',
      currency char(3) NOT NULL DEFAULT 'USD' CONSTRAINT ck_organizations_currency CHECK (currency ~ '^[A-Z]{3}$'),
      owner_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
      row_version int NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX idx_organizations_owner ON organizations (owner_user_id);
    CREATE TABLE organization_memberships (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      status text NOT NULL DEFAULT 'active'
        CONSTRAINT ck_organization_memberships_status CHECK (status IN ('invited','active','suspended','removed')),
      joined_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by uuid,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by uuid,
      CONSTRAINT uq_organization_memberships_org_user UNIQUE (organization_id, user_id)
    );
    CREATE INDEX idx_organization_memberships_user ON organization_memberships (user_id);
    CREATE TABLE audit_events (
      id uuid PRIMARY KEY,
      organization_id uuid REFERENCES organizations(id) ON DELETE RESTRICT,
      actor_id uuid,
      actor_type text NOT NULL DEFAULT 'user',
      action text NOT NULL,
      resource_type text,
      resource_id text,
      outcome text NOT NULL CONSTRAINT ck_audit_events_outcome CHECK (outcome IN ('success','failure','denied')),
      correlation_id text,
      ip inet,
      user_agent text,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      occurred_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX idx_audit_events_org_time ON audit_events (organization_id, occurred_at DESC);
    CREATE INDEX idx_audit_events_org_actor ON audit_events (organization_id, actor_id);
    CREATE INDEX idx_audit_events_org_resource ON audit_events (organization_id, resource_type, resource_id);

    CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
    END
    $fn$;
    CREATE TRIGGER trg_audit_events_append_only BEFORE UPDATE OR DELETE ON audit_events
      FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
  `);

  for (const t of TENANT_TABLES) {
    await knex.raw(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`);
    await knex.raw(
      `CREATE POLICY tenant_isolation ON ${t}
         USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid)
         WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid)`,
    );
  }
  await knex.raw(`GRANT SELECT, INSERT, UPDATE ON users, organizations, organization_memberships TO nexus_app`);
  await knex.raw(`GRANT SELECT, INSERT ON audit_events TO nexus_app`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    DROP TABLE IF EXISTS audit_events, organization_memberships, organizations, users CASCADE;
    DROP FUNCTION IF EXISTS forbid_mutation();
  `);
}
