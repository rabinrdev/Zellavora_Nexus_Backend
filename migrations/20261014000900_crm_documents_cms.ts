import type { Knex } from 'knex';
import { appendOnly, enableTenantRls, grantApp } from '../src/db/migration-helpers.js';

const ORG = `organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE`;
const AUDIT = `created_at timestamptz NOT NULL DEFAULT now(), created_by uuid, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid`;
const SOFT = `deleted_at timestamptz, deleted_by uuid, row_version int NOT NULL DEFAULT 1`;

const APPEND_ONLY = ['client_activities', 'content_versions'];
const TABLES = [
  'leads', 'contacts', 'enquiries', 'follow_ups', 'client_activities', 'portal_accounts',
  'document_categories', 'documents', 'document_versions', 'document_metadata', 'document_acl',
  'content_categories', 'content_items', 'content_versions', 'media_assets', 'content_blocks', 'publish_versions',
  'layout_presets', 'themes', 'brand_assets',
];

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE leads (
      id uuid PRIMARY KEY, ${ORG},
      name text NOT NULL, email citext, phone text, company text, source text,
      status text NOT NULL DEFAULT 'new' CONSTRAINT ck_leads_status CHECK (status IN ('new','contacted','qualified','lost','converted')),
      owner_id uuid REFERENCES users(id), notes text NOT NULL DEFAULT '', converted_customer_id uuid,
      ${AUDIT}, ${SOFT}
    );
    CREATE UNIQUE INDEX uq_leads_email ON leads (organization_id, email) WHERE deleted_at IS NULL AND email IS NOT NULL;
    CREATE UNIQUE INDEX uq_leads_phone ON leads (organization_id, phone) WHERE deleted_at IS NULL AND phone IS NOT NULL;
    CREATE INDEX idx_leads_org_status ON leads (organization_id, status);
    CREATE TABLE contacts (
      id uuid PRIMARY KEY, ${ORG},
      customer_id uuid REFERENCES billing_customers(id) ON DELETE SET NULL,
      name text NOT NULL, email citext, phone text, job_title text,
      ${AUDIT}, ${SOFT}
    );
    CREATE UNIQUE INDEX uq_contacts_email ON contacts (organization_id, email) WHERE deleted_at IS NULL AND email IS NOT NULL;
    CREATE UNIQUE INDEX uq_contacts_phone ON contacts (organization_id, phone) WHERE deleted_at IS NULL AND phone IS NOT NULL;
    CREATE INDEX idx_contacts_customer ON contacts (organization_id, customer_id);
    CREATE TABLE enquiries (
      id uuid PRIMARY KEY, ${ORG},
      customer_id uuid REFERENCES billing_customers(id) ON DELETE SET NULL,
      contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
      subject text NOT NULL, message text NOT NULL,
      status text NOT NULL DEFAULT 'open' CONSTRAINT ck_enquiries_status CHECK (status IN ('open','in_progress','resolved','closed')),
      assignee_id uuid REFERENCES users(id), via_portal boolean NOT NULL DEFAULT false,
      ${AUDIT}, ${SOFT}
    );
    CREATE INDEX idx_enquiries_org_status ON enquiries (organization_id, status);
    CREATE INDEX idx_enquiries_customer ON enquiries (organization_id, customer_id);
    CREATE TABLE follow_ups (
      id uuid PRIMARY KEY, ${ORG},
      customer_id uuid REFERENCES billing_customers(id) ON DELETE CASCADE,
      lead_id uuid REFERENCES leads(id) ON DELETE CASCADE,
      title text NOT NULL, due_at timestamptz NOT NULL,
      status text NOT NULL DEFAULT 'open' CONSTRAINT ck_follow_ups_status CHECK (status IN ('open','done','cancelled')),
      assignee_id uuid REFERENCES users(id), reminded_at timestamptz,
      ${AUDIT}, ${SOFT}
    );
    CREATE INDEX idx_follow_ups_due ON follow_ups (organization_id, status, due_at);
    CREATE TABLE client_activities (
      id uuid PRIMARY KEY, ${ORG},
      customer_id uuid NOT NULL REFERENCES billing_customers(id) ON DELETE CASCADE,
      kind text NOT NULL, summary text NOT NULL, actor_id uuid, ref_type text, ref_id uuid,
      occurred_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX idx_client_activities_customer ON client_activities (organization_id, customer_id, occurred_at DESC);
    CREATE TABLE portal_accounts (
      id uuid PRIMARY KEY, ${ORG},
      customer_id uuid NOT NULL REFERENCES billing_customers(id) ON DELETE CASCADE,
      email citext NOT NULL, name text NOT NULL, password_hash text,
      status text NOT NULL DEFAULT 'invited' CONSTRAINT ck_portal_accounts_status CHECK (status IN ('invited','active','disabled')),
      setup_token_hash text UNIQUE, setup_expires_at timestamptz,
      failed_count int NOT NULL DEFAULT 0, locked_until timestamptz, last_login_at timestamptz,
      ${AUDIT},
      UNIQUE (organization_id, email)
    );

    CREATE TABLE document_categories (
      id uuid PRIMARY KEY, ${ORG}, name text NOT NULL, parent_id uuid REFERENCES document_categories(id) ON DELETE RESTRICT,
      ${AUDIT}, ${SOFT}
    );
    CREATE UNIQUE INDEX uq_document_categories_name ON document_categories (organization_id, lower(name)) WHERE deleted_at IS NULL;
    CREATE TABLE documents (
      id uuid PRIMARY KEY, ${ORG},
      title text NOT NULL, description text NOT NULL DEFAULT '',
      category_id uuid REFERENCES document_categories(id) ON DELETE SET NULL,
      owner_id uuid NOT NULL REFERENCES users(id), current_version int NOT NULL DEFAULT 1,
      expires_at date, expiry_reminded_at timestamptz,
      ${AUDIT}, ${SOFT}
    );
    CREATE INDEX idx_documents_org_category ON documents (organization_id, category_id) WHERE deleted_at IS NULL;
    CREATE INDEX idx_documents_title_trgm ON documents USING gin (title gin_trgm_ops);
    CREATE INDEX idx_documents_expiry ON documents (expires_at) WHERE deleted_at IS NULL AND expires_at IS NOT NULL;
    CREATE TABLE document_versions (
      id uuid PRIMARY KEY, ${ORG},
      document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      version int NOT NULL, file_id uuid NOT NULL REFERENCES files(id),
      note text, created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
      UNIQUE (document_id, version)
    );
    CREATE INDEX idx_document_versions_file ON document_versions (file_id);
    CREATE TABLE document_metadata (
      id uuid PRIMARY KEY, ${ORG},
      document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      key text NOT NULL, value_type text NOT NULL CONSTRAINT ck_doc_meta_type CHECK (value_type IN ('string','number','date','boolean')),
      value text NOT NULL, UNIQUE (document_id, key)
    );
    CREATE TABLE document_acl (
      id uuid PRIMARY KEY, ${ORG},
      document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      principal_type text NOT NULL CONSTRAINT ck_doc_acl_type CHECK (principal_type IN ('user','role','group')),
      principal_id uuid NOT NULL,
      permission text NOT NULL CONSTRAINT ck_doc_acl_perm CHECK (permission IN ('view','edit','manage')),
      UNIQUE (document_id, principal_type, principal_id)
    );
    CREATE INDEX idx_document_acl_principal ON document_acl (organization_id, principal_type, principal_id);

    CREATE TABLE content_categories (
      id uuid PRIMARY KEY, ${ORG}, name text NOT NULL, slug text NOT NULL, ${AUDIT}, ${SOFT}
    );
    CREATE UNIQUE INDEX uq_content_categories_slug ON content_categories (organization_id, slug) WHERE deleted_at IS NULL;
    CREATE TABLE content_items (
      id uuid PRIMARY KEY, ${ORG},
      type text NOT NULL CONSTRAINT ck_content_items_type CHECK (type IN ('page','post')),
      slug text NOT NULL, title text NOT NULL, excerpt text NOT NULL DEFAULT '', body text NOT NULL DEFAULT '',
      status text NOT NULL DEFAULT 'draft' CONSTRAINT ck_content_items_status CHECK (status IN ('draft','scheduled','published','unpublished')),
      category_id uuid REFERENCES content_categories(id) ON DELETE SET NULL,
      seo jsonb NOT NULL DEFAULT '{}'::jsonb, layout_key text,
      publish_at timestamptz, published_at timestamptz, current_version int NOT NULL DEFAULT 1, published_version int, author_id uuid,
      ${AUDIT}, ${SOFT}
    );
    CREATE UNIQUE INDEX uq_content_items_slug ON content_items (organization_id, type, slug) WHERE deleted_at IS NULL;
    CREATE INDEX idx_content_items_org_status ON content_items (organization_id, type, status);
    CREATE INDEX idx_content_items_schedule ON content_items (publish_at) WHERE status = 'scheduled';
    CREATE TABLE content_versions (
      id uuid PRIMARY KEY, ${ORG},
      item_id uuid NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
      version int NOT NULL, snapshot jsonb NOT NULL, note text, created_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (item_id, version)
    );
    CREATE TABLE media_assets (
      id uuid PRIMARY KEY, ${ORG},
      file_id uuid NOT NULL REFERENCES files(id), alt_text text NOT NULL DEFAULT '', title text NOT NULL DEFAULT '',
      ${AUDIT}, UNIQUE (organization_id, file_id)
    );
    CREATE TABLE layout_presets (
      id uuid PRIMARY KEY, organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
      key text NOT NULL, name text NOT NULL, blocks jsonb NOT NULL DEFAULT '[]'::jsonb
    );
    CREATE UNIQUE INDEX uq_layout_presets ON layout_presets (coalesce(organization_id, '00000000-0000-0000-0000-000000000000'::uuid), key);
    CREATE TABLE content_blocks (
      id uuid PRIMARY KEY, ${ORG},
      item_id uuid NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
      type text NOT NULL, props jsonb NOT NULL DEFAULT '{}'::jsonb, position int NOT NULL DEFAULT 0,
      ${AUDIT}
    );
    CREATE INDEX idx_content_blocks_item ON content_blocks (organization_id, item_id, position);
    CREATE TABLE publish_versions (
      id uuid PRIMARY KEY, ${ORG},
      item_id uuid NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
      version int NOT NULL, blocks jsonb NOT NULL, published_at timestamptz NOT NULL DEFAULT now(), published_by uuid,
      UNIQUE (item_id, version)
    );
    CREATE TABLE themes (
      id uuid PRIMARY KEY, ${ORG},
      name text NOT NULL, tokens jsonb NOT NULL, is_active boolean NOT NULL DEFAULT false,
      ${AUDIT}, row_version int NOT NULL DEFAULT 1
    );
    CREATE UNIQUE INDEX uq_themes_active ON themes (organization_id) WHERE is_active;
    CREATE UNIQUE INDEX uq_themes_name ON themes (organization_id, lower(name));
    CREATE TABLE brand_assets (
      id uuid PRIMARY KEY, ${ORG},
      kind text NOT NULL CONSTRAINT ck_brand_assets_kind CHECK (kind IN ('logo','favicon','banner')),
      file_id uuid NOT NULL REFERENCES files(id), ${AUDIT},
      UNIQUE (organization_id, kind)
    );
  `);
  for (const t of APPEND_ONLY) await appendOnly(knex, t);
  for (const t of TABLES) await enableTenantRls(knex, t, { orgNullable: t === 'layout_presets' });
  await grantApp(knex, TABLES.filter((t) => !APPEND_ONLY.includes(t)));
  await grantApp(knex, APPEND_ONLY, 'SELECT, INSERT');
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS ${[...TABLES].reverse().join(', ')} CASCADE`);
}
