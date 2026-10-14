import type { Knex } from 'knex';
import { appendOnly, enableTenantRls, grantApp } from '../src/db/migration-helpers.js';

const TENANT = [
  'roles', 'user_role_assignments', 'user_groups', 'user_group_members', 'group_roles', 'access_requests',
  'access_history', 'invitations', 'departments', 'locations', 'organization_settings', 'security_events',
  'saved_dashboard_views', 'files', 'storage_usage', 'outbox_events', 'job_runs', 'idempotency_records',
];

export async function up(knex: Knex): Promise<void> {
  // platform scope + "my memberships" policies for tables created in migration 1
  await enableTenantRls(knex, 'organization_memberships');
  await enableTenantRls(knex, 'audit_events', { orgNullable: false });
  await knex.raw(`DROP POLICY IF EXISTS own_memberships ON organization_memberships`);
  await knex.raw(
    `CREATE POLICY own_memberships ON organization_memberships FOR SELECT
       USING (user_id = nullif(current_setting('app.current_user', true), '')::uuid)`,
  );
  await knex.raw(`ALTER TABLE organization_memberships ALTER COLUMN joined_at SET DEFAULT now()`);

  await knex.raw(`
    CREATE TABLE sessions (
      id uuid PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      active_organization_id uuid REFERENCES organizations(id) ON DELETE SET NULL,
      refresh_token_hash text NOT NULL UNIQUE,
      family_id uuid NOT NULL,
      realm text NOT NULL DEFAULT 'staff',
      ip inet, user_agent text,
      mfa_verified boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      last_seen_at timestamptz NOT NULL DEFAULT now(),
      idle_expires_at timestamptz NOT NULL,
      absolute_expires_at timestamptz NOT NULL,
      revoked_at timestamptz, revoked_reason text,
      rotated_at timestamptz
    );
    CREATE INDEX idx_sessions_user ON sessions (user_id);
    CREATE INDEX idx_sessions_family ON sessions (family_id);
    CREATE INDEX idx_sessions_org ON sessions (active_organization_id);

    CREATE TABLE verification_tokens (
      id uuid PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      purpose text NOT NULL CONSTRAINT ck_verification_tokens_purpose CHECK (purpose IN ('email_verify','password_reset')),
      token_hash text NOT NULL UNIQUE,
      expires_at timestamptz NOT NULL,
      used_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX idx_verification_tokens_user ON verification_tokens (user_id);

    CREATE TABLE password_history (
      id uuid PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      password_hash text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX idx_password_history_user ON password_history (user_id, created_at DESC);

    CREATE TABLE mfa_factors (
      id uuid PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type text NOT NULL DEFAULT 'totp' CONSTRAINT ck_mfa_factors_type CHECK (type IN ('totp')),
      secret_encrypted text NOT NULL,
      confirmed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX uq_mfa_factors_user_type ON mfa_factors (user_id, type);
    CREATE TABLE mfa_recovery_codes (
      id uuid PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code_hash text NOT NULL,
      used_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX idx_mfa_recovery_codes_user ON mfa_recovery_codes (user_id);

    CREATE TABLE permissions (
      key text PRIMARY KEY,
      resource text NOT NULL,
      action text NOT NULL,
      description text NOT NULL DEFAULT '',
      module text NOT NULL DEFAULT 'core'
    );

    CREATE TABLE roles (
      id uuid PRIMARY KEY,
      organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
      key text NOT NULL,
      name text NOT NULL,
      description text NOT NULL DEFAULT '',
      is_system boolean NOT NULL DEFAULT false,
      privileged boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
      updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
      row_version int NOT NULL DEFAULT 1
    );
    CREATE UNIQUE INDEX uq_roles_org_key ON roles (coalesce(organization_id, '00000000-0000-0000-0000-000000000000'::uuid), key);
    CREATE TABLE role_permissions (
      role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      permission_key text NOT NULL REFERENCES permissions(key) ON DELETE CASCADE,
      PRIMARY KEY (role_id, permission_key)
    );
    CREATE INDEX idx_role_permissions_perm ON role_permissions (permission_key);

    CREATE TABLE user_role_assignments (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      membership_id uuid NOT NULL REFERENCES organization_memberships(id) ON DELETE CASCADE,
      role_id uuid NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
      scope_type text NOT NULL DEFAULT 'organization',
      scope_id uuid,
      created_at timestamptz NOT NULL DEFAULT now(), created_by uuid
    );
    CREATE UNIQUE INDEX uq_user_role_assignments ON user_role_assignments
      (membership_id, role_id, scope_type, coalesce(scope_id, '00000000-0000-0000-0000-000000000000'::uuid));
    CREATE INDEX idx_user_role_assignments_org ON user_role_assignments (organization_id, membership_id);
    CREATE INDEX idx_user_role_assignments_role ON user_role_assignments (role_id);

    CREATE TABLE user_groups (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      name text NOT NULL, description text NOT NULL DEFAULT '',
      created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
      updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid
    );
    CREATE UNIQUE INDEX uq_user_groups_org_name ON user_groups (organization_id, lower(name));
    CREATE TABLE user_group_members (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      group_id uuid NOT NULL REFERENCES user_groups(id) ON DELETE CASCADE,
      membership_id uuid NOT NULL REFERENCES organization_memberships(id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (group_id, membership_id)
    );
    CREATE INDEX idx_user_group_members_org ON user_group_members (organization_id, membership_id);
    CREATE TABLE group_roles (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      group_id uuid NOT NULL REFERENCES user_groups(id) ON DELETE CASCADE,
      role_id uuid NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
      UNIQUE (group_id, role_id)
    );
    CREATE INDEX idx_group_roles_org ON group_roles (organization_id, role_id);

    CREATE TABLE access_requests (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      requester_id uuid NOT NULL REFERENCES users(id),
      role_id uuid NOT NULL REFERENCES roles(id),
      reason text NOT NULL,
      status text NOT NULL DEFAULT 'pending'
        CONSTRAINT ck_access_requests_status CHECK (status IN ('pending','approved','denied','cancelled')),
      decided_by uuid REFERENCES users(id), decided_at timestamptz, decision_note text,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      row_version int NOT NULL DEFAULT 1
    );
    CREATE INDEX idx_access_requests_org_status ON access_requests (organization_id, status);
    CREATE TABLE access_history (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      actor_id uuid, subject_user_id uuid, role_id uuid,
      change text NOT NULL, reason text,
      occurred_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX idx_access_history_org_time ON access_history (organization_id, occurred_at DESC);

    CREATE TABLE invitations (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      email citext NOT NULL,
      role_id uuid REFERENCES roles(id),
      token_hash text NOT NULL UNIQUE,
      status text NOT NULL DEFAULT 'pending'
        CONSTRAINT ck_invitations_status CHECK (status IN ('pending','accepted','revoked','expired')),
      expires_at timestamptz NOT NULL,
      invited_by uuid REFERENCES users(id),
      accepted_at timestamptz, revoked_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX uq_invitations_pending ON invitations (organization_id, email) WHERE status = 'pending';
    CREATE INDEX idx_invitations_org ON invitations (organization_id, status);

    CREATE TABLE departments (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      parent_id uuid REFERENCES departments(id) ON DELETE RESTRICT,
      name text NOT NULL, head_user_id uuid REFERENCES users(id),
      created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
      updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
      deleted_at timestamptz, deleted_by uuid, row_version int NOT NULL DEFAULT 1
    );
    CREATE UNIQUE INDEX uq_departments_org_name ON departments (organization_id, lower(name)) WHERE deleted_at IS NULL;
    CREATE INDEX idx_departments_parent ON departments (parent_id);
    CREATE TABLE locations (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      name text NOT NULL, address text, timezone text,
      created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
      updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
      deleted_at timestamptz, deleted_by uuid, row_version int NOT NULL DEFAULT 1
    );
    CREATE UNIQUE INDEX uq_locations_org_name ON locations (organization_id, lower(name)) WHERE deleted_at IS NULL;

    CREATE TABLE organization_settings (
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      key text NOT NULL, value jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
      PRIMARY KEY (organization_id, key)
    );
    CREATE TABLE application_settings (
      key text PRIMARY KEY, value jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid
    );
    CREATE TABLE user_preferences (
      user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      preferences jsonb NOT NULL DEFAULT '{}'::jsonb,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE feature_flags (
      key text PRIMARY KEY, description text NOT NULL DEFAULT '',
      default_enabled boolean NOT NULL DEFAULT false,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE feature_flag_overrides (
      id uuid PRIMARY KEY,
      flag_key text NOT NULL REFERENCES feature_flags(key) ON DELETE CASCADE,
      target_org_id uuid REFERENCES organizations(id) ON DELETE CASCADE, -- platform-managed config, not tenant-owned data
      user_id uuid REFERENCES users(id) ON DELETE CASCADE,
      enabled boolean NOT NULL
    );
    CREATE UNIQUE INDEX uq_flag_overrides ON feature_flag_overrides
      (flag_key, coalesce(target_org_id, '00000000-0000-0000-0000-000000000000'::uuid),
       coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid));
    CREATE TABLE api_version_policy (
      version text PRIMARY KEY, status text NOT NULL DEFAULT 'current',
      deprecated_at timestamptz, sunset_at timestamptz
    );
    INSERT INTO api_version_policy (version, status) VALUES ('v1', 'current');

    CREATE TABLE security_events (
      id uuid PRIMARY KEY,
      organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
      user_id uuid, event text NOT NULL, outcome text NOT NULL DEFAULT 'success',
      ip inet, user_agent text, correlation_id text,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      occurred_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX idx_security_events_org_time ON security_events (organization_id, occurred_at DESC);
    CREATE INDEX idx_security_events_user ON security_events (user_id, occurred_at DESC);

    CREATE TABLE saved_dashboard_views (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name text NOT NULL, filters jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      row_version int NOT NULL DEFAULT 1
    );
    CREATE INDEX idx_saved_dashboard_views_org_user ON saved_dashboard_views (organization_id, user_id);

    CREATE TABLE files (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      owner_id uuid NOT NULL REFERENCES users(id),
      object_key text NOT NULL UNIQUE,
      original_filename text NOT NULL, content_type text NOT NULL,
      size bigint NOT NULL CONSTRAINT ck_files_size CHECK (size >= 0),
      sha256 char(64) NOT NULL,
      scan_status text NOT NULL DEFAULT 'pending'
        CONSTRAINT ck_files_scan CHECK (scan_status IN ('pending','clean','infected','failed')),
      purpose text NOT NULL DEFAULT 'general',
      created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
      deleted_at timestamptz, deleted_by uuid
    );
    CREATE INDEX idx_files_org ON files (organization_id, created_at DESC);
    CREATE INDEX idx_files_owner ON files (owner_id);
    CREATE TABLE storage_usage (
      organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
      bytes_used bigint NOT NULL DEFAULT 0 CONSTRAINT ck_storage_usage_nonneg CHECK (bytes_used >= 0),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE idempotency_records (
      id uuid PRIMARY KEY,
      organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
      scope_id text NOT NULL,
      key text NOT NULL, route text NOT NULL, request_hash text NOT NULL,
      state text NOT NULL DEFAULT 'in_flight',
      response_status int, response_body jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      UNIQUE (scope_id, key, route)
    );
    CREATE INDEX idx_idempotency_expires ON idempotency_records (expires_at);

    CREATE TABLE outbox_events (
      id uuid PRIMARY KEY,
      organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
      type text NOT NULL, payload jsonb NOT NULL,
      correlation_id text,
      created_at timestamptz NOT NULL DEFAULT now(),
      dispatched_at timestamptz
    );
    CREATE INDEX idx_outbox_undispatched ON outbox_events (created_at) WHERE dispatched_at IS NULL;
    CREATE TABLE job_runs (
      id uuid PRIMARY KEY,
      organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
      queue text NOT NULL, status text NOT NULL, attempts int NOT NULL DEFAULT 0,
      error_summary text,
      started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz
    );
    CREATE INDEX idx_job_runs_queue ON job_runs (queue, started_at DESC);
  `);

  await appendOnly(knex, 'access_history');
  await appendOnly(knex, 'security_events');
  for (const t of TENANT) {
    await enableTenantRls(knex, t, { orgNullable: ['roles', 'security_events', 'outbox_events', 'job_runs', 'idempotency_records'].includes(t) });
  }
  // storage_usage / settings use organization_id as PK column: same policy shape works.
  await grantApp(knex, [
    'sessions', 'verification_tokens', 'password_history', 'mfa_factors', 'mfa_recovery_codes', 'permissions',
    'roles', 'role_permissions', 'user_role_assignments', 'user_groups', 'user_group_members', 'group_roles',
    'access_requests', 'invitations', 'departments', 'locations', 'organization_settings', 'application_settings',
    'user_preferences', 'feature_flags', 'feature_flag_overrides', 'api_version_policy', 'saved_dashboard_views',
    'files', 'storage_usage', 'idempotency_records', 'outbox_events', 'job_runs',
  ]);
  await grantApp(knex, ['access_history', 'security_events'], 'SELECT, INSERT');
  await knex.raw(`GRANT SELECT, DELETE ON audit_events TO nexus_app`); // DELETE blocked by trigger; retention uses privileged fn
  await knex.raw(`REVOKE DELETE ON audit_events FROM nexus_app`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    DROP TABLE IF EXISTS job_runs, outbox_events, idempotency_records, storage_usage, files,
      saved_dashboard_views, security_events, api_version_policy, feature_flag_overrides, feature_flags,
      user_preferences, application_settings, organization_settings, locations, departments, invitations,
      access_history, access_requests, group_roles, user_group_members, user_groups, user_role_assignments,
      role_permissions, roles, permissions, mfa_recovery_codes, mfa_factors, password_history,
      verification_tokens, sessions CASCADE;
    DROP POLICY IF EXISTS own_memberships ON organization_memberships;
    DROP POLICY IF EXISTS platform_scope ON organization_memberships;
    DROP POLICY IF EXISTS platform_scope ON audit_events;
  `);
}
