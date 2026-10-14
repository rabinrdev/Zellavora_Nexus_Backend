import type { Knex } from 'knex';
import { appendOnly, enableTenantRls, grantApp } from '../src/db/migration-helpers.js';

const ORG = `organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE`;
const AUDIT = `created_at timestamptz NOT NULL DEFAULT now(), created_by uuid, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid`;

const TENANT = [
  'subscriptions', 'subscription_invoices', 'usage_records',
  'integration_configs', 'webhook_endpoints', 'webhook_events', 'webhook_deliveries',
  'saved_reports', 'saved_filters', 'report_schedules',
  'support_access_grants', 'tenant_health_snapshots', 'operational_alerts', 'tenant_provisioning_jobs',
  'help_articles', 'help_feedback',
];

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE plans (
      key text PRIMARY KEY, name text NOT NULL, description text NOT NULL DEFAULT '',
      price numeric(19,4) NOT NULL DEFAULT 0 CONSTRAINT ck_plans_price CHECK (price >= 0),
      currency char(3) NOT NULL DEFAULT 'USD', interval text NOT NULL DEFAULT 'month' CONSTRAINT ck_plans_interval CHECK (interval IN ('month','year')),
      trial_days int NOT NULL DEFAULT 0, active boolean NOT NULL DEFAULT true, public boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE plan_entitlements (
      plan_key text NOT NULL REFERENCES plans(key) ON DELETE CASCADE,
      feature_key text NOT NULL, enabled boolean NOT NULL DEFAULT true, limit_value bigint,
      PRIMARY KEY (plan_key, feature_key)
    );
    CREATE TABLE subscriptions (
      id uuid PRIMARY KEY, ${ORG},
      plan_key text NOT NULL REFERENCES plans(key),
      status text NOT NULL DEFAULT 'trialing'
        CONSTRAINT ck_subscriptions_status CHECK (status IN ('trialing','active','past_due','cancelled','expired')),
      current_period_start timestamptz NOT NULL, current_period_end timestamptz NOT NULL, trial_end timestamptz,
      cancel_at_period_end boolean NOT NULL DEFAULT false, cancelled_at timestamptz,
      past_due_since timestamptz, dunning_attempts int NOT NULL DEFAULT 0, last_attempt_at timestamptz,
      restricted boolean NOT NULL DEFAULT false,
      provider text NOT NULL DEFAULT 'manual', customer_ref text,
      ${AUDIT}, row_version int NOT NULL DEFAULT 1
    );
    CREATE UNIQUE INDEX uq_subscriptions_live ON subscriptions (organization_id) WHERE status IN ('trialing','active','past_due');
    CREATE INDEX idx_subscriptions_period ON subscriptions (status, current_period_end);
    CREATE TABLE subscription_invoices (
      id uuid PRIMARY KEY, ${ORG},
      subscription_id uuid NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
      amount numeric(19,4) NOT NULL, currency char(3) NOT NULL,
      status text NOT NULL DEFAULT 'open' CONSTRAINT ck_sub_invoices_status CHECK (status IN ('open','paid','failed','void')),
      period_start timestamptz NOT NULL, period_end timestamptz NOT NULL, provider_ref text,
      created_at timestamptz NOT NULL DEFAULT now(), paid_at timestamptz
    );
    CREATE INDEX idx_sub_invoices_sub ON subscription_invoices (organization_id, subscription_id, created_at DESC);
    CREATE TABLE usage_records (
      id uuid PRIMARY KEY, ${ORG},
      subscription_id uuid REFERENCES subscriptions(id) ON DELETE SET NULL,
      metric text NOT NULL, quantity numeric(19,4) NOT NULL CONSTRAINT ck_usage_qty CHECK (quantity >= 0),
      event_id text NOT NULL, occurred_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (organization_id, metric, event_id)
    );
    CREATE INDEX idx_usage_org_metric ON usage_records (organization_id, metric, occurred_at);
    CREATE TABLE billing_events (
      id uuid PRIMARY KEY, provider text NOT NULL, event_id text NOT NULL, type text NOT NULL,
      payload jsonb NOT NULL, target_org_id uuid, processed_at timestamptz, outcome text,
      received_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (provider, event_id)
    );

    CREATE TABLE integration_configs (
      id uuid PRIMARY KEY, ${ORG},
      provider text NOT NULL, name text NOT NULL, config_encrypted text NOT NULL,
      status text NOT NULL DEFAULT 'active' CONSTRAINT ck_integration_configs_status CHECK (status IN ('active','disabled')),
      ${AUDIT}, UNIQUE (organization_id, provider, name)
    );
    CREATE TABLE webhook_endpoints (
      id uuid PRIMARY KEY, ${ORG},
      url text NOT NULL, description text NOT NULL DEFAULT '', secret_encrypted text NOT NULL, event_types text[] NOT NULL DEFAULT '{*}',
      status text NOT NULL DEFAULT 'active' CONSTRAINT ck_webhook_endpoints_status CHECK (status IN ('active','disabled')),
      consecutive_failures int NOT NULL DEFAULT 0, disabled_reason text, previous_secret_encrypted text, previous_secret_expires_at timestamptz,
      ${AUDIT}, row_version int NOT NULL DEFAULT 1
    );
    CREATE INDEX idx_webhook_endpoints_org ON webhook_endpoints (organization_id, status);
    CREATE TABLE webhook_events (
      id uuid PRIMARY KEY, ${ORG},
      type text NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX idx_webhook_events_org ON webhook_events (organization_id, created_at DESC);
    CREATE TABLE webhook_deliveries (
      id uuid PRIMARY KEY, ${ORG},
      endpoint_id uuid NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
      event_id uuid NOT NULL REFERENCES webhook_events(id) ON DELETE CASCADE,
      status text NOT NULL DEFAULT 'pending' CONSTRAINT ck_webhook_deliveries_status CHECK (status IN ('pending','delivered','failed','dead')),
      attempt int NOT NULL DEFAULT 0, response_status int, error_summary text,
      last_attempt_at timestamptz, next_attempt_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (endpoint_id, event_id, created_at)
    );
    CREATE INDEX idx_webhook_deliveries_endpoint ON webhook_deliveries (organization_id, endpoint_id, created_at DESC);
    CREATE INDEX idx_webhook_deliveries_event ON webhook_deliveries (event_id);

    CREATE TABLE saved_reports (
      id uuid PRIMARY KEY, ${ORG},
      name text NOT NULL, definition jsonb NOT NULL, owner_id uuid NOT NULL REFERENCES users(id), shared boolean NOT NULL DEFAULT false,
      ${AUDIT}, row_version int NOT NULL DEFAULT 1
    );
    CREATE INDEX idx_saved_reports_org ON saved_reports (organization_id, owner_id);
    CREATE TABLE saved_filters (
      id uuid PRIMARY KEY, ${ORG},
      dataset text NOT NULL, name text NOT NULL, filters jsonb NOT NULL, owner_id uuid NOT NULL REFERENCES users(id),
      ${AUDIT}
    );
    CREATE TABLE report_schedules (
      id uuid PRIMARY KEY, ${ORG},
      saved_report_id uuid NOT NULL REFERENCES saved_reports(id) ON DELETE CASCADE,
      frequency text NOT NULL CONSTRAINT ck_report_schedules_freq CHECK (frequency IN ('daily','weekly','monthly')),
      format text NOT NULL DEFAULT 'csv', recipient_ids uuid[] NOT NULL DEFAULT '{}',
      next_run_at timestamptz NOT NULL, last_run_at timestamptz, active boolean NOT NULL DEFAULT true,
      ${AUDIT}
    );
    CREATE INDEX idx_report_schedules_due ON report_schedules (next_run_at) WHERE active;

    CREATE TABLE support_access_grants (
      id uuid PRIMARY KEY, ${ORG},
      granted_by uuid NOT NULL REFERENCES users(id), reason text NOT NULL,
      expires_at timestamptz NOT NULL, revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT ck_support_grants_window CHECK (expires_at > created_at)
    );
    CREATE INDEX idx_support_grants_org ON support_access_grants (organization_id, expires_at);
    CREATE TABLE tenant_health_snapshots (
      id uuid PRIMARY KEY, ${ORG}, snapshot jsonb NOT NULL, taken_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX idx_tenant_health_org ON tenant_health_snapshots (organization_id, taken_at DESC);
    CREATE TABLE operational_alerts (
      id uuid PRIMARY KEY, organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
      severity text NOT NULL CONSTRAINT ck_alerts_severity CHECK (severity IN ('info','warning','critical')),
      title text NOT NULL, detail text, status text NOT NULL DEFAULT 'open' CONSTRAINT ck_alerts_status CHECK (status IN ('open','acknowledged','resolved')),
      created_at timestamptz NOT NULL DEFAULT now(), acknowledged_by uuid, acknowledged_at timestamptz
    );
    CREATE INDEX idx_alerts_status ON operational_alerts (status, created_at DESC);
    CREATE TABLE tenant_provisioning_jobs (
      id uuid PRIMARY KEY, organization_id uuid REFERENCES organizations(id) ON DELETE SET NULL,
      requested_by uuid, request jsonb NOT NULL, status text NOT NULL DEFAULT 'running'
        CONSTRAINT ck_provisioning_status CHECK (status IN ('running','completed','failed')),
      steps jsonb NOT NULL DEFAULT '[]'::jsonb, error_summary text,
      created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz
    );

    CREATE TABLE help_articles (
      id uuid PRIMARY KEY, organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
      slug text NOT NULL, title text NOT NULL, body text NOT NULL, category text NOT NULL DEFAULT 'general',
      locale text NOT NULL DEFAULT 'en', status text NOT NULL DEFAULT 'draft' CONSTRAINT ck_help_status CHECK (status IN ('draft','published')),
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid
    );
    CREATE UNIQUE INDEX uq_help_articles ON help_articles (coalesce(organization_id, '00000000-0000-0000-0000-000000000000'::uuid), slug, locale);
    CREATE INDEX idx_help_articles_title_trgm ON help_articles USING gin (title gin_trgm_ops);
    CREATE TABLE help_feedback (
      id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      article_id uuid NOT NULL REFERENCES help_articles(id) ON DELETE CASCADE, user_id uuid NOT NULL REFERENCES users(id),
      helpful boolean NOT NULL, comment text, created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (article_id, user_id)
    );
  `);
  await appendOnly(knex, 'billing_events');
  // billing_events is a global inbox keyed by provider event id; processed_at/outcome are set once by the handler,
  // so it is append-only except for those two columns — enforce with a column-aware guard instead of the generic trigger.
  await knex.raw('DROP TRIGGER IF EXISTS trg_billing_events_append_only ON billing_events');
  await knex.raw(`
    CREATE OR REPLACE FUNCTION guard_billing_events() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      IF TG_OP = 'DELETE' AND current_setting('nexus.purge', true) <> 'on' THEN RAISE EXCEPTION 'billing_events is append-only' USING ERRCODE = 'restrict_violation'; END IF;
      IF TG_OP = 'UPDATE' AND (NEW.payload::text <> OLD.payload::text OR NEW.type <> OLD.type OR NEW.event_id <> OLD.event_id OR NEW.provider <> OLD.provider) THEN
        RAISE EXCEPTION 'billing_events payload is immutable' USING ERRCODE = 'restrict_violation';
      END IF;
      RETURN COALESCE(NEW, OLD);
    END
    $fn$;
    CREATE TRIGGER trg_billing_events_guard BEFORE UPDATE OR DELETE ON billing_events FOR EACH ROW EXECUTE FUNCTION guard_billing_events();
  `);
  for (const t of TENANT) {
    await enableTenantRls(knex, t, { orgNullable: ['operational_alerts', 'tenant_provisioning_jobs', 'help_articles'].includes(t) });
  }
  await grantApp(knex, [...TENANT, 'plans', 'plan_entitlements']);
  await grantApp(knex, ['billing_events'], 'SELECT, INSERT, UPDATE');
  await knex.raw(`
    INSERT INTO plans (key, name, description, price, trial_days) VALUES
      ('free', 'Free', 'Get started', 0, 0),
      ('pro', 'Pro', 'For growing teams', 49, 14),
      ('enterprise', 'Enterprise', 'Advanced controls', 199, 14);
    INSERT INTO plan_entitlements (plan_key, feature_key, enabled, limit_value) VALUES
      ('free', 'max_projects', true, 3), ('free', 'max_members', true, 5), ('free', 'storage_bytes', true, 104857600),
      ('free', 'api_access', false, NULL), ('free', 'webhooks', false, NULL), ('free', 'advanced_reports', false, NULL),
      ('pro', 'max_projects', true, 50), ('pro', 'max_members', true, 50), ('pro', 'storage_bytes', true, 10737418240),
      ('pro', 'api_access', true, NULL), ('pro', 'webhooks', true, NULL), ('pro', 'advanced_reports', true, NULL),
      ('enterprise', 'max_projects', true, NULL), ('enterprise', 'max_members', true, NULL), ('enterprise', 'storage_bytes', true, 1099511627776),
      ('enterprise', 'api_access', true, NULL), ('enterprise', 'webhooks', true, NULL), ('enterprise', 'advanced_reports', true, NULL);
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    DROP TRIGGER IF EXISTS trg_billing_events_guard ON billing_events;
    DROP FUNCTION IF EXISTS guard_billing_events();
    DROP TABLE IF EXISTS help_feedback, help_articles, tenant_provisioning_jobs, operational_alerts, tenant_health_snapshots,
      support_access_grants, report_schedules, saved_filters, saved_reports, webhook_deliveries, webhook_events, webhook_endpoints,
      integration_configs, billing_events, usage_records, subscription_invoices, subscriptions, plan_entitlements, plans CASCADE;
  `);
}
