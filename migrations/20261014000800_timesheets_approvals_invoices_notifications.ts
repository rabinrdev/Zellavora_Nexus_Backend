import type { Knex } from 'knex';
import { appendOnly, enableTenantRls, grantApp } from '../src/db/migration-helpers.js';

const ORG = `organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE`;
const AUDIT = `created_at timestamptz NOT NULL DEFAULT now(), created_by uuid, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid`;
const MONEY = (n: string) => `${n} numeric(19,4) NOT NULL DEFAULT 0`;

const APPEND_ONLY = ['timesheet_corrections', 'invoice_status_history'];
const TABLES = [
  'timesheets', 'time_entries', 'timesheet_corrections',
  'approval_templates', 'approval_requests', 'approval_steps', 'approval_step_approvers', 'approval_decisions', 'approval_delegations',
  'billing_customers', 'tax_configurations', 'numbering_sequences', 'invoices', 'invoice_lines', 'payments', 'payment_allocations',
  'credit_notes', 'invoice_status_history',
  'notifications', 'notification_preferences', 'notification_templates', 'delivery_attempts',
];

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE timesheets (
      id uuid PRIMARY KEY, ${ORG},
      user_id uuid NOT NULL REFERENCES users(id),
      period_start date NOT NULL, period_end date NOT NULL,
      status text NOT NULL DEFAULT 'draft' CONSTRAINT ck_timesheets_status CHECK (status IN ('draft','submitted','approved','rejected')),
      revision int NOT NULL DEFAULT 1,
      submitted_at timestamptz, decided_at timestamptz, decided_by uuid, decision_note text,
      approval_request_id uuid,
      ${AUDIT}, row_version int NOT NULL DEFAULT 1,
      CONSTRAINT ck_timesheets_period CHECK (period_end >= period_start),
      UNIQUE (organization_id, user_id, period_start)
    );
    CREATE INDEX idx_timesheets_org_status ON timesheets (organization_id, status, period_start);
    CREATE TABLE time_entries (
      id uuid PRIMARY KEY, ${ORG},
      timesheet_id uuid NOT NULL REFERENCES timesheets(id) ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES users(id),
      project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
      task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
      work_date date NOT NULL,
      minutes int NOT NULL CONSTRAINT ck_time_entries_minutes CHECK (minutes BETWEEN 1 AND 1440),
      billable boolean NOT NULL DEFAULT false,
      description text NOT NULL DEFAULT '',
      invoice_id uuid,
      ${AUDIT}
    );
    CREATE UNIQUE INDEX uq_time_entries_dup ON time_entries
      (timesheet_id, work_date, coalesce(project_id, '00000000-0000-0000-0000-000000000000'::uuid),
       coalesce(task_id, '00000000-0000-0000-0000-000000000000'::uuid), minutes, description);
    CREATE INDEX idx_time_entries_sheet ON time_entries (organization_id, timesheet_id);
    CREATE INDEX idx_time_entries_project ON time_entries (organization_id, project_id, work_date);
    CREATE INDEX idx_time_entries_user_date ON time_entries (organization_id, user_id, work_date);
    CREATE TABLE timesheet_corrections (
      id uuid PRIMARY KEY, ${ORG},
      timesheet_id uuid NOT NULL, revision_from int NOT NULL, revision_to int NOT NULL,
      reason text NOT NULL, actor_id uuid, occurred_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX idx_timesheet_corrections_sheet ON timesheet_corrections (organization_id, timesheet_id);

    CREATE TABLE approval_templates (
      id uuid PRIMARY KEY, ${ORG},
      key text NOT NULL, name text NOT NULL, subject_type text NOT NULL,
      steps jsonb NOT NULL, prevent_self_approval boolean NOT NULL DEFAULT true, active boolean NOT NULL DEFAULT true,
      ${AUDIT}, row_version int NOT NULL DEFAULT 1,
      UNIQUE (organization_id, key)
    );
    CREATE TABLE approval_requests (
      id uuid PRIMARY KEY, ${ORG},
      template_id uuid REFERENCES approval_templates(id),
      subject_type text NOT NULL, subject_id uuid, title text NOT NULL,
      requester_id uuid NOT NULL REFERENCES users(id),
      status text NOT NULL DEFAULT 'pending'
        CONSTRAINT ck_approval_requests_status CHECK (status IN ('pending','approved','rejected','changes_requested','cancelled')),
      current_step int NOT NULL DEFAULT 1, payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      prevent_self_approval boolean NOT NULL DEFAULT true,
      workflow_instance_id uuid, completed_at timestamptz, round int NOT NULL DEFAULT 1,
      ${AUDIT}, row_version int NOT NULL DEFAULT 1
    );
    CREATE INDEX idx_approval_requests_org_status ON approval_requests (organization_id, status);
    CREATE INDEX idx_approval_requests_requester ON approval_requests (organization_id, requester_id);
    CREATE INDEX idx_approval_requests_subject ON approval_requests (organization_id, subject_type, subject_id);
    CREATE TABLE approval_steps (
      id uuid PRIMARY KEY, ${ORG},
      request_id uuid NOT NULL REFERENCES approval_requests(id) ON DELETE CASCADE,
      step_order int NOT NULL,
      mode text NOT NULL DEFAULT 'any' CONSTRAINT ck_approval_steps_mode CHECK (mode IN ('any','all','quorum')),
      quorum int NOT NULL DEFAULT 1 CONSTRAINT ck_approval_steps_quorum CHECK (quorum >= 1),
      status text NOT NULL DEFAULT 'waiting' CONSTRAINT ck_approval_steps_status CHECK (status IN ('waiting','active','approved','rejected','skipped')),
      due_at timestamptz, reminded_at timestamptz, escalated_at timestamptz, escalate_to uuid,
      UNIQUE (request_id, step_order)
    );
    CREATE INDEX idx_approval_steps_due ON approval_steps (organization_id, status, due_at);
    CREATE TABLE approval_step_approvers (
      id uuid PRIMARY KEY, ${ORG},
      step_id uuid NOT NULL REFERENCES approval_steps(id) ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES users(id),
      via text NOT NULL DEFAULT 'direct',
      UNIQUE (step_id, user_id)
    );
    CREATE INDEX idx_approval_approvers_user ON approval_step_approvers (organization_id, user_id);
    CREATE TABLE approval_decisions (
      id uuid PRIMARY KEY, ${ORG},
      request_id uuid NOT NULL REFERENCES approval_requests(id) ON DELETE CASCADE,
      step_id uuid NOT NULL REFERENCES approval_steps(id) ON DELETE CASCADE,
      approver_id uuid NOT NULL REFERENCES users(id),
      decision text NOT NULL CONSTRAINT ck_approval_decisions_decision CHECK (decision IN ('approve','reject','request_changes','reassign')),
      comment text, round int NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (step_id, approver_id, round)
    );
    CREATE INDEX idx_approval_decisions_request ON approval_decisions (organization_id, request_id);
    CREATE TABLE approval_delegations (
      id uuid PRIMARY KEY, ${ORG},
      delegator_id uuid NOT NULL REFERENCES users(id), delegate_id uuid NOT NULL REFERENCES users(id),
      starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL, active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT ck_approval_delegations_window CHECK (ends_at > starts_at),
      CONSTRAINT ck_approval_delegations_self CHECK (delegator_id <> delegate_id)
    );
    CREATE INDEX idx_approval_delegations_delegator ON approval_delegations (organization_id, delegator_id, active);

    CREATE TABLE billing_customers (
      id uuid PRIMARY KEY, ${ORG},
      name text NOT NULL, email citext, tax_id text, address jsonb NOT NULL DEFAULT '{}'::jsonb,
      currency char(3) NOT NULL DEFAULT 'USD' CONSTRAINT ck_billing_customers_currency CHECK (currency ~ '^[A-Z]{3}$'),
      ${AUDIT}, deleted_at timestamptz, deleted_by uuid, row_version int NOT NULL DEFAULT 1
    );
    CREATE UNIQUE INDEX uq_billing_customers_name ON billing_customers (organization_id, lower(name)) WHERE deleted_at IS NULL;
    CREATE TABLE tax_configurations (
      id uuid PRIMARY KEY, ${ORG},
      name text NOT NULL, rate numeric(9,6) NOT NULL CONSTRAINT ck_tax_rate CHECK (rate >= 0 AND rate <= 100),
      inclusive boolean NOT NULL DEFAULT false, compound boolean NOT NULL DEFAULT false,
      effective_from date NOT NULL DEFAULT CURRENT_DATE, effective_to date, active boolean NOT NULL DEFAULT true,
      ${AUDIT},
      CONSTRAINT ck_tax_window CHECK (effective_to IS NULL OR effective_to >= effective_from)
    );
    CREATE INDEX idx_tax_configurations_org ON tax_configurations (organization_id, active);
    CREATE TABLE numbering_sequences (
      id uuid PRIMARY KEY, ${ORG},
      series text NOT NULL, period text NOT NULL DEFAULT '', prefix text NOT NULL DEFAULT 'INV-',
      next_number bigint NOT NULL DEFAULT 1 CONSTRAINT ck_numbering_next CHECK (next_number >= 1),
      padding int NOT NULL DEFAULT 5 CONSTRAINT ck_numbering_padding CHECK (padding BETWEEN 1 AND 12),
      reset_yearly boolean NOT NULL DEFAULT true,
      UNIQUE (organization_id, series, period)
    );
    CREATE TABLE invoices (
      id uuid PRIMARY KEY, ${ORG},
      customer_id uuid NOT NULL REFERENCES billing_customers(id),
      number text, series text NOT NULL DEFAULT 'default',
      status text NOT NULL DEFAULT 'draft'
        CONSTRAINT ck_invoices_status CHECK (status IN ('draft','sent','partially_paid','paid','overdue','void')),
      issue_date date, due_date date,
      currency char(3) NOT NULL CONSTRAINT ck_invoices_currency CHECK (currency ~ '^[A-Z]{3}$'),
      ${MONEY('subtotal')}, ${MONEY('discount_total')}, ${MONEY('tax_total')}, ${MONEY('total')},
      ${MONEY('amount_paid')}, ${MONEY('amount_credited')}, ${MONEY('balance')},
      source text NOT NULL DEFAULT 'manual' CONSTRAINT ck_invoices_source CHECK (source IN ('manual','timesheet','subscription')),
      notes text NOT NULL DEFAULT '', sent_at timestamptz, voided_at timestamptz, void_reason text,
      ${AUDIT}, row_version int NOT NULL DEFAULT 1,
      CONSTRAINT ck_invoices_amounts CHECK (total >= 0 AND amount_paid >= 0 AND balance >= 0 AND amount_credited >= 0)
    );
    CREATE UNIQUE INDEX uq_invoices_number ON invoices (organization_id, series, number) WHERE number IS NOT NULL;
    CREATE INDEX idx_invoices_org_status ON invoices (organization_id, status, due_date);
    CREATE INDEX idx_invoices_customer ON invoices (organization_id, customer_id);
    CREATE TABLE invoice_lines (
      id uuid PRIMARY KEY, ${ORG},
      invoice_id uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
      position int NOT NULL, description text NOT NULL,
      quantity numeric(12,4) NOT NULL CONSTRAINT ck_lines_qty CHECK (quantity > 0),
      unit_price numeric(19,4) NOT NULL CONSTRAINT ck_lines_price CHECK (unit_price >= 0),
      discount_pct numeric(9,6) NOT NULL DEFAULT 0 CONSTRAINT ck_lines_discount CHECK (discount_pct BETWEEN 0 AND 100),
      tax_ids uuid[] NOT NULL DEFAULT '{}',
      ${MONEY('line_subtotal')}, ${MONEY('line_discount')}, ${MONEY('line_tax')}, ${MONEY('line_total')},
      project_id uuid
    );
    CREATE INDEX idx_invoice_lines_invoice ON invoice_lines (organization_id, invoice_id, position);
    CREATE TABLE payments (
      id uuid PRIMARY KEY, ${ORG},
      customer_id uuid NOT NULL REFERENCES billing_customers(id),
      amount numeric(19,4) NOT NULL CONSTRAINT ck_payments_amount CHECK (amount > 0),
      unallocated numeric(19,4) NOT NULL CONSTRAINT ck_payments_unallocated CHECK (unallocated >= 0),
      currency char(3) NOT NULL, method text NOT NULL DEFAULT 'manual', reference text,
      received_on date NOT NULL DEFAULT CURRENT_DATE,
      status text NOT NULL DEFAULT 'recorded' CONSTRAINT ck_payments_status CHECK (status IN ('recorded','reversed')),
      ${AUDIT}
    );
    CREATE INDEX idx_payments_org ON payments (organization_id, received_on DESC);
    CREATE INDEX idx_payments_reference ON payments (organization_id, reference);
    CREATE TABLE payment_allocations (
      id uuid PRIMARY KEY, ${ORG},
      payment_id uuid NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
      invoice_id uuid NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
      amount numeric(19,4) NOT NULL CONSTRAINT ck_alloc_amount CHECK (amount > 0),
      created_at timestamptz NOT NULL DEFAULT now(), created_by uuid
    );
    CREATE INDEX idx_alloc_invoice ON payment_allocations (organization_id, invoice_id);
    CREATE INDEX idx_alloc_payment ON payment_allocations (organization_id, payment_id);
    CREATE TABLE credit_notes (
      id uuid PRIMARY KEY, ${ORG},
      invoice_id uuid NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
      number text, amount numeric(19,4) NOT NULL CONSTRAINT ck_credit_amount CHECK (amount > 0),
      reason text NOT NULL, status text NOT NULL DEFAULT 'issued' CONSTRAINT ck_credit_status CHECK (status IN ('issued','void')),
      ${AUDIT}
    );
    CREATE INDEX idx_credit_notes_invoice ON credit_notes (organization_id, invoice_id);
    CREATE TABLE invoice_status_history (
      id uuid PRIMARY KEY, ${ORG},
      invoice_id uuid NOT NULL, from_status text, to_status text NOT NULL, actor_id uuid, note text,
      occurred_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX idx_invoice_history_invoice ON invoice_status_history (organization_id, invoice_id, occurred_at);

    CREATE TABLE notifications (
      id uuid PRIMARY KEY, ${ORG},
      recipient_id uuid NOT NULL REFERENCES users(id),
      type text NOT NULL, title text NOT NULL, body text NOT NULL DEFAULT '', link text,
      payload jsonb NOT NULL DEFAULT '{}'::jsonb, dedupe_key text, in_app boolean NOT NULL DEFAULT true,
      read_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX idx_notifications_recipient ON notifications (organization_id, recipient_id, read_at, created_at DESC);
    CREATE UNIQUE INDEX uq_notifications_dedupe ON notifications (organization_id, recipient_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
    CREATE TABLE notification_preferences (
      id uuid PRIMARY KEY, ${ORG},
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      event_type text NOT NULL, channel text NOT NULL CONSTRAINT ck_notif_pref_channel CHECK (channel IN ('in_app','email')),
      enabled boolean NOT NULL DEFAULT true,
      UNIQUE (organization_id, user_id, event_type, channel)
    );
    CREATE TABLE notification_templates (
      id uuid PRIMARY KEY, ${ORG},
      event_type text NOT NULL, channel text NOT NULL, locale text NOT NULL DEFAULT 'en',
      subject text NOT NULL, body text NOT NULL, version int NOT NULL DEFAULT 1, active boolean NOT NULL DEFAULT true,
      ${AUDIT},
      UNIQUE (organization_id, event_type, channel, locale, version)
    );
    CREATE TABLE delivery_attempts (
      id uuid PRIMARY KEY, ${ORG},
      notification_id uuid, channel text NOT NULL, provider text NOT NULL DEFAULT 'mail',
      status text NOT NULL, attempt int NOT NULL DEFAULT 1, error_summary text, recipient text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX idx_delivery_attempts_org ON delivery_attempts (organization_id, created_at DESC);

    -- Immutable money history: paid/void invoices cannot be edited or removed at the database level.
    CREATE OR REPLACE FUNCTION guard_finalized_invoice() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      IF TG_OP = 'DELETE' AND OLD.status <> 'draft' THEN
        RAISE EXCEPTION 'only draft invoices can be deleted' USING ERRCODE = 'restrict_violation';
      END IF;
      IF TG_OP = 'UPDATE' AND OLD.status IN ('paid','void')
         AND (NEW.total <> OLD.total OR NEW.subtotal <> OLD.subtotal OR NEW.currency <> OLD.currency OR NEW.customer_id <> OLD.customer_id) THEN
        RAISE EXCEPTION 'finalized invoices are immutable' USING ERRCODE = 'restrict_violation';
      END IF;
      RETURN COALESCE(NEW, OLD);
    END
    $fn$;
    CREATE TRIGGER trg_invoices_guard BEFORE UPDATE OR DELETE ON invoices FOR EACH ROW EXECUTE FUNCTION guard_finalized_invoice();

    -- Published workflow versions are immutable (only status may move published -> retired).
    CREATE OR REPLACE FUNCTION guard_workflow_version() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      IF OLD.status <> 'draft' AND (NEW.states::text <> OLD.states::text OR NEW.transitions::text <> OLD.transitions::text
         OR NEW.rules::text <> OLD.rules::text OR NEW.initial_state <> OLD.initial_state) THEN
        RAISE EXCEPTION 'published workflow versions are immutable' USING ERRCODE = 'restrict_violation';
      END IF;
      RETURN NEW;
    END
    $fn$;
    CREATE TRIGGER trg_workflow_versions_guard BEFORE UPDATE ON workflow_versions FOR EACH ROW EXECUTE FUNCTION guard_workflow_version();
  `);
  for (const t of APPEND_ONLY) await appendOnly(knex, t);
  for (const t of TABLES) await enableTenantRls(knex, t);
  await grantApp(knex, TABLES.filter((t) => !APPEND_ONLY.includes(t)));
  await grantApp(knex, APPEND_ONLY, 'SELECT, INSERT');
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    DROP TRIGGER IF EXISTS trg_workflow_versions_guard ON workflow_versions;
    DROP FUNCTION IF EXISTS guard_workflow_version();
    DROP TABLE IF EXISTS ${[...TABLES].reverse().join(', ')} CASCADE;
    DROP FUNCTION IF EXISTS guard_finalized_invoice();
  `);
}
