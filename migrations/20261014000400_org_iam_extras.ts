import type { Knex } from 'knex';
import { appendOnly, enableTenantRls, grantApp } from '../src/db/migration-helpers.js';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE ownership_transfers (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      from_user_id uuid NOT NULL REFERENCES users(id),
      to_user_id uuid NOT NULL REFERENCES users(id),
      status text NOT NULL DEFAULT 'pending'
        CONSTRAINT ck_ownership_transfers_status CHECK (status IN ('pending','accepted','cancelled','expired')),
      expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(), decided_at timestamptz
    );
    CREATE UNIQUE INDEX uq_ownership_transfers_pending ON ownership_transfers (organization_id) WHERE status = 'pending';
    CREATE INDEX idx_ownership_transfers_to ON ownership_transfers (to_user_id);

    CREATE TABLE access_reviews (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      name text NOT NULL,
      status text NOT NULL DEFAULT 'open' CONSTRAINT ck_access_reviews_status CHECK (status IN ('open','completed')),
      due_at timestamptz,
      created_by uuid, created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
    );
    CREATE INDEX idx_access_reviews_org ON access_reviews (organization_id, status);
    CREATE TABLE access_review_items (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      review_id uuid NOT NULL REFERENCES access_reviews(id) ON DELETE CASCADE,
      assignment_id uuid NOT NULL,
      subject_user_id uuid NOT NULL REFERENCES users(id),
      role_id uuid NOT NULL REFERENCES roles(id),
      decision text NOT NULL DEFAULT 'pending' CONSTRAINT ck_access_review_items_decision CHECK (decision IN ('pending','keep','revoke')),
      decided_by uuid, decided_at timestamptz,
      UNIQUE (review_id, assignment_id)
    );
    CREATE INDEX idx_access_review_items_review ON access_review_items (review_id);
    CREATE INDEX idx_access_review_items_org ON access_review_items (organization_id);
    CREATE TABLE membership_history (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      user_id uuid NOT NULL,
      change text NOT NULL, actor_id uuid, note text,
      occurred_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX idx_membership_history_org ON membership_history (organization_id, occurred_at DESC);
  `);
  await appendOnly(knex, 'membership_history');
  for (const t of ['ownership_transfers', 'access_reviews', 'access_review_items', 'membership_history']) {
    await enableTenantRls(knex, t);
  }
  await grantApp(knex, ['ownership_transfers', 'access_reviews', 'access_review_items']);
  await grantApp(knex, ['membership_history'], 'SELECT, INSERT');
  await knex.raw(`GRANT DELETE ON user_role_assignments, user_group_members, group_roles, invitations TO nexus_app`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(
    `DROP TABLE IF EXISTS membership_history, access_review_items, access_reviews, ownership_transfers CASCADE`,
  );
}
