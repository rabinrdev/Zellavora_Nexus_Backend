import type { Knex } from 'knex';
import { appendOnly, enableTenantRls, grantApp } from '../src/db/migration-helpers.js';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE users ADD COLUMN is_platform_admin boolean NOT NULL DEFAULT false;
    ALTER TABLE organizations
      ADD COLUMN logo_file_id uuid, ADD COLUMN branding jsonb NOT NULL DEFAULT '{}'::jsonb,
      ADD COLUMN suspended_reason text, ADD COLUMN plan_key text; -- NULL = unmetered (no plan assigned)
    ALTER TABLE sessions ADD COLUMN pending_mfa boolean NOT NULL DEFAULT false;

    CREATE TABLE used_refresh_tokens (
      token_hash text PRIMARY KEY,
      session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      used_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX idx_used_refresh_tokens_session ON used_refresh_tokens (session_id);

    CREATE TABLE security_policies (
      id uuid PRIMARY KEY,
      organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
      policy jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid
    );
    CREATE UNIQUE INDEX uq_security_policies_org ON security_policies (coalesce(organization_id, '00000000-0000-0000-0000-000000000000'::uuid));

    CREATE TABLE audit_retention_policies (
      organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
      retention_days int NOT NULL CONSTRAINT ck_audit_retention_days CHECK (retention_days BETWEEN 30 AND 3650),
      legal_hold boolean NOT NULL DEFAULT false,
      updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid
    );

    CREATE TABLE permission_change_requests (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      requested_by uuid NOT NULL REFERENCES users(id),
      change_type text NOT NULL, payload jsonb NOT NULL,
      status text NOT NULL DEFAULT 'pending'
        CONSTRAINT ck_pcr_status CHECK (status IN ('pending','approved','rejected','applied')),
      decided_by uuid REFERENCES users(id), decided_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX idx_pcr_org_status ON permission_change_requests (organization_id, status);

    CREATE TABLE lookup_types (
      id uuid PRIMARY KEY,
      organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
      key text NOT NULL, name text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX uq_lookup_types ON lookup_types (coalesce(organization_id, '00000000-0000-0000-0000-000000000000'::uuid), key);
    CREATE TABLE lookup_values (
      id uuid PRIMARY KEY,
      organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
      type_id uuid NOT NULL REFERENCES lookup_types(id) ON DELETE CASCADE,
      code text NOT NULL, label text NOT NULL, sort_order int NOT NULL DEFAULT 0,
      active boolean NOT NULL DEFAULT true,
      UNIQUE (type_id, code)
    );
    CREATE INDEX idx_lookup_values_type ON lookup_values (type_id, sort_order);

    CREATE TABLE import_jobs (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      resource text NOT NULL, status text NOT NULL DEFAULT 'pending'
        CONSTRAINT ck_import_jobs_status CHECK (status IN ('pending','validating','processing','completed','failed','dry_run')),
      dry_run boolean NOT NULL DEFAULT false,
      total_rows int NOT NULL DEFAULT 0, success_rows int NOT NULL DEFAULT 0, error_rows int NOT NULL DEFAULT 0,
      errors jsonb NOT NULL DEFAULT '[]'::jsonb,
      created_by uuid, created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz
    );
    CREATE INDEX idx_import_jobs_org ON import_jobs (organization_id, created_at DESC);
    CREATE TABLE export_jobs (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      kind text NOT NULL, format text NOT NULL DEFAULT 'csv',
      status text NOT NULL DEFAULT 'pending'
        CONSTRAINT ck_export_jobs_status CHECK (status IN ('pending','processing','completed','failed')),
      file_id uuid REFERENCES files(id), params jsonb NOT NULL DEFAULT '{}'::jsonb,
      requested_by uuid, created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
      expires_at timestamptz
    );
    CREATE INDEX idx_export_jobs_org ON export_jobs (organization_id, created_at DESC);
    CREATE TABLE data_retention_policies (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      resource text NOT NULL, retention_days int NOT NULL CONSTRAINT ck_drp_days CHECK (retention_days >= 1),
      action text NOT NULL DEFAULT 'purge' CONSTRAINT ck_drp_action CHECK (action IN ('archive','purge')),
      legal_hold boolean NOT NULL DEFAULT false,
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (organization_id, resource)
    );
    CREATE TABLE deletion_requests (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      requested_by uuid NOT NULL REFERENCES users(id),
      status text NOT NULL DEFAULT 'pending'
        CONSTRAINT ck_deletion_requests_status CHECK (status IN ('pending','cancelled','executed')),
      execute_after timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), decided_at timestamptz
    );
    CREATE INDEX idx_deletion_requests_org ON deletion_requests (organization_id, status);
    CREATE TABLE privacy_requests (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      subject_user_id uuid NOT NULL REFERENCES users(id),
      kind text NOT NULL CONSTRAINT ck_privacy_kind CHECK (kind IN ('access','export','erasure','rectification')),
      status text NOT NULL DEFAULT 'open'
        CONSTRAINT ck_privacy_status CHECK (status IN ('open','in_progress','completed','rejected')),
      due_at timestamptz NOT NULL, handled_by uuid REFERENCES users(id), notes text,
      created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
    );
    CREATE INDEX idx_privacy_requests_org ON privacy_requests (organization_id, status);
    CREATE TABLE api_keys (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      name text NOT NULL, prefix text NOT NULL, key_hash text NOT NULL UNIQUE,
      scopes text[] NOT NULL DEFAULT '{}', expires_at timestamptz,
      last_used_at timestamptz, revoked_at timestamptz,
      created_by uuid, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX idx_api_keys_org ON api_keys (organization_id);
    CREATE TABLE release_records (
      id uuid PRIMARY KEY, version text NOT NULL, git_sha text, notes text,
      released_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE incident_records (
      id uuid PRIMARY KEY, title text NOT NULL, severity text NOT NULL, status text NOT NULL DEFAULT 'open',
      summary text, created_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz
    );
    CREATE TABLE deployment_records (
      id uuid PRIMARY KEY, version text NOT NULL, environment text NOT NULL, status text NOT NULL,
      deployed_at timestamptz NOT NULL DEFAULT now(), notes text
    );
    CREATE TABLE backup_runs (
      id uuid PRIMARY KEY, status text NOT NULL, location text, size_bytes bigint,
      started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz
    );
  `);

  for (const t of [
    'security_policies', 'audit_retention_policies', 'permission_change_requests', 'lookup_types', 'lookup_values',
    'import_jobs', 'export_jobs', 'data_retention_policies', 'deletion_requests', 'privacy_requests', 'api_keys',
  ]) {
    await enableTenantRls(knex, t, { orgNullable: ['security_policies', 'lookup_types', 'lookup_values'].includes(t) });
  }
  await grantApp(knex, [
    'security_policies', 'audit_retention_policies', 'permission_change_requests', 'lookup_types', 'lookup_values',
    'import_jobs', 'export_jobs', 'data_retention_policies', 'deletion_requests', 'privacy_requests', 'api_keys',
    'release_records', 'incident_records', 'deployment_records', 'backup_runs', 'used_refresh_tokens',
  ]);
  await knex.raw(`GRANT DELETE ON users, organization_memberships, organizations TO nexus_app`);
  void appendOnly;
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    DROP TABLE IF EXISTS used_refresh_tokens, backup_runs, deployment_records, incident_records, release_records, api_keys,
      privacy_requests, deletion_requests, data_retention_policies, export_jobs, import_jobs, lookup_values,
      lookup_types, permission_change_requests, audit_retention_policies, security_policies CASCADE;
    ALTER TABLE sessions DROP COLUMN IF EXISTS pending_mfa;
    ALTER TABLE organizations DROP COLUMN IF EXISTS logo_file_id, DROP COLUMN IF EXISTS branding,
      DROP COLUMN IF EXISTS suspended_reason, DROP COLUMN IF EXISTS plan_key;
    ALTER TABLE users DROP COLUMN IF EXISTS is_platform_admin;
  `);
}
