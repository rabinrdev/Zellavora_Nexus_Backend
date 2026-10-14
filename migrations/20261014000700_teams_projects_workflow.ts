import type { Knex } from 'knex';
import { appendOnly, enableTenantRls, grantApp } from '../src/db/migration-helpers.js';

const std = (extra = '') => `
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      ${extra}
      created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
      updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid`;

const TABLES = [
  'teams', 'team_members', 'team_membership_history', 'projects', 'project_members', 'milestones', 'tasks',
  'task_dependencies', 'task_comments', 'task_activity', 'recurring_task_rules', 'recurring_task_occurrences',
  'project_templates', 'project_template_tasks', 'task_attachments',
  'workflow_definitions', 'workflow_versions', 'workflow_instances', 'workflow_actions', 'workflow_failures',
];

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE teams (${std(`
      name text NOT NULL, description text NOT NULL DEFAULT '',
      department_id uuid REFERENCES departments(id) ON DELETE SET NULL,
      permissions jsonb NOT NULL DEFAULT '[]'::jsonb,`)},
      deleted_at timestamptz, deleted_by uuid, row_version int NOT NULL DEFAULT 1
    );
    CREATE UNIQUE INDEX uq_teams_org_name ON teams (organization_id, lower(name)) WHERE deleted_at IS NULL;
    CREATE INDEX idx_teams_department ON teams (department_id);
    CREATE TABLE team_members (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES users(id),
      is_leader boolean NOT NULL DEFAULT false,
      joined_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
      UNIQUE (team_id, user_id)
    );
    CREATE INDEX idx_team_members_org_user ON team_members (organization_id, user_id);
    CREATE TABLE team_membership_history (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      team_id uuid NOT NULL, user_id uuid NOT NULL, change text NOT NULL, actor_id uuid,
      occurred_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX idx_team_membership_history_team ON team_membership_history (organization_id, team_id, occurred_at DESC);

    CREATE TABLE projects (${std(`
      name text NOT NULL, description text NOT NULL DEFAULT '', code text,
      status text NOT NULL DEFAULT 'planning'
        CONSTRAINT ck_projects_status CHECK (status IN ('planning','active','on_hold','completed','archived')),
      owner_id uuid REFERENCES users(id), start_date date, end_date date,
      budget_hours numeric(10,2) CONSTRAINT ck_projects_budget CHECK (budget_hours IS NULL OR budget_hours >= 0),
      template_id uuid,`)},
      deleted_at timestamptz, deleted_by uuid, row_version int NOT NULL DEFAULT 1,
      CONSTRAINT ck_projects_dates CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date)
    );
    CREATE UNIQUE INDEX uq_projects_org_name ON projects (organization_id, lower(name)) WHERE deleted_at IS NULL;
    CREATE INDEX idx_projects_org_status ON projects (organization_id, status);
    CREATE INDEX idx_projects_owner ON projects (owner_id);
    CREATE TABLE project_members (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES users(id),
      role text NOT NULL DEFAULT 'contributor' CONSTRAINT ck_project_members_role CHECK (role IN ('lead','contributor','viewer')),
      created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
      UNIQUE (project_id, user_id)
    );
    CREATE INDEX idx_project_members_org_user ON project_members (organization_id, user_id);
    CREATE TABLE milestones (${std(`
      project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name text NOT NULL, due_date date,
      status text NOT NULL DEFAULT 'open' CONSTRAINT ck_milestones_status CHECK (status IN ('open','reached','missed')),`)},
      deleted_at timestamptz, deleted_by uuid, row_version int NOT NULL DEFAULT 1
    );
    CREATE INDEX idx_milestones_project ON milestones (organization_id, project_id);
    CREATE TABLE tasks (${std(`
      project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      parent_task_id uuid REFERENCES tasks(id) ON DELETE CASCADE,
      milestone_id uuid REFERENCES milestones(id) ON DELETE SET NULL,
      title text NOT NULL, description text NOT NULL DEFAULT '',
      status text NOT NULL DEFAULT 'todo'
        CONSTRAINT ck_tasks_status CHECK (status IN ('todo','in_progress','in_review','done','cancelled')),
      priority text NOT NULL DEFAULT 'medium' CONSTRAINT ck_tasks_priority CHECK (priority IN ('low','medium','high','urgent')),
      assignee_id uuid REFERENCES users(id), due_date date,
      estimate_hours numeric(8,2) CONSTRAINT ck_tasks_estimate CHECK (estimate_hours IS NULL OR estimate_hours >= 0),
      position double precision NOT NULL DEFAULT 0, completed_at timestamptz,`)},
      deleted_at timestamptz, deleted_by uuid, row_version int NOT NULL DEFAULT 1
    );
    CREATE INDEX idx_tasks_project_status ON tasks (organization_id, project_id, status, position);
    CREATE INDEX idx_tasks_assignee ON tasks (organization_id, assignee_id) WHERE deleted_at IS NULL;
    CREATE INDEX idx_tasks_due ON tasks (organization_id, due_date) WHERE deleted_at IS NULL;
    CREATE INDEX idx_tasks_parent ON tasks (parent_task_id);
    CREATE INDEX idx_tasks_milestone ON tasks (milestone_id);
    CREATE TABLE task_dependencies (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      depends_on_task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
      CONSTRAINT ck_task_dependencies_self CHECK (task_id <> depends_on_task_id),
      UNIQUE (task_id, depends_on_task_id)
    );
    CREATE INDEX idx_task_dependencies_dep ON task_dependencies (depends_on_task_id);
    CREATE TABLE task_comments (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      author_id uuid NOT NULL REFERENCES users(id), body text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz
    );
    CREATE INDEX idx_task_comments_task ON task_comments (organization_id, task_id, created_at);
    CREATE TABLE task_attachments (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      file_id uuid NOT NULL REFERENCES files(id), created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
      UNIQUE (task_id, file_id)
    );
    CREATE TABLE task_activity (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      task_id uuid NOT NULL, project_id uuid NOT NULL, actor_id uuid,
      action text NOT NULL, changes jsonb NOT NULL DEFAULT '{}'::jsonb,
      occurred_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX idx_task_activity_task ON task_activity (organization_id, task_id, occurred_at DESC);
    CREATE INDEX idx_task_activity_project ON task_activity (organization_id, project_id, occurred_at DESC);

    CREATE TABLE recurring_task_rules (${std(`
      project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title text NOT NULL, description text NOT NULL DEFAULT '',
      priority text NOT NULL DEFAULT 'medium', assignee_id uuid REFERENCES users(id),
      frequency text NOT NULL CONSTRAINT ck_recurring_frequency CHECK (frequency IN ('daily','weekly','monthly')),
      interval_count int NOT NULL DEFAULT 1 CONSTRAINT ck_recurring_interval CHECK (interval_count BETWEEN 1 AND 52),
      next_run_on date NOT NULL, end_on date, active boolean NOT NULL DEFAULT true,
      estimate_hours numeric(8,2),`)},
      row_version int NOT NULL DEFAULT 1
    );
    CREATE INDEX idx_recurring_due ON recurring_task_rules (next_run_on) WHERE active;
    CREATE TABLE recurring_task_occurrences (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      rule_id uuid NOT NULL REFERENCES recurring_task_rules(id) ON DELETE CASCADE,
      occurrence_date date NOT NULL, task_id uuid,
      UNIQUE (rule_id, occurrence_date)
    );
    CREATE TABLE project_templates (${std(`name text NOT NULL, description text NOT NULL DEFAULT '',`)},
      deleted_at timestamptz, deleted_by uuid, row_version int NOT NULL DEFAULT 1
    );
    CREATE UNIQUE INDEX uq_project_templates_name ON project_templates (organization_id, lower(name)) WHERE deleted_at IS NULL;
    CREATE TABLE project_template_tasks (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      template_id uuid NOT NULL REFERENCES project_templates(id) ON DELETE CASCADE,
      title text NOT NULL, description text NOT NULL DEFAULT '', priority text NOT NULL DEFAULT 'medium',
      offset_days int NOT NULL DEFAULT 0, position int NOT NULL DEFAULT 0, estimate_hours numeric(8,2)
    );
    CREATE INDEX idx_template_tasks_template ON project_template_tasks (organization_id, template_id, position);

    CREATE TABLE workflow_definitions (${std(`
      key text NOT NULL, name text NOT NULL, entity_type text NOT NULL, description text NOT NULL DEFAULT '',`)},
      row_version int NOT NULL DEFAULT 1,
      UNIQUE (organization_id, key)
    );
    CREATE TABLE workflow_versions (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      definition_id uuid NOT NULL REFERENCES workflow_definitions(id) ON DELETE CASCADE,
      version int NOT NULL,
      status text NOT NULL DEFAULT 'draft' CONSTRAINT ck_workflow_versions_status CHECK (status IN ('draft','published','retired')),
      initial_state text NOT NULL, states jsonb NOT NULL, transitions jsonb NOT NULL, rules jsonb NOT NULL DEFAULT '[]'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(), created_by uuid, published_at timestamptz,
      UNIQUE (definition_id, version)
    );
    CREATE INDEX idx_workflow_versions_org ON workflow_versions (organization_id, definition_id, status);
    CREATE TABLE workflow_instances (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      definition_id uuid NOT NULL REFERENCES workflow_definitions(id),
      version_id uuid NOT NULL REFERENCES workflow_versions(id),
      subject_type text NOT NULL, subject_id uuid NOT NULL,
      state text NOT NULL, status text NOT NULL DEFAULT 'active' CONSTRAINT ck_workflow_instances_status CHECK (status IN ('active','completed','failed')),
      context jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(), created_by uuid, updated_at timestamptz NOT NULL DEFAULT now(),
      row_version int NOT NULL DEFAULT 1
    );
    CREATE INDEX idx_workflow_instances_subject ON workflow_instances (organization_id, subject_type, subject_id);
    CREATE INDEX idx_workflow_instances_version ON workflow_instances (version_id);
    CREATE TABLE workflow_actions (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      instance_id uuid NOT NULL REFERENCES workflow_instances(id) ON DELETE CASCADE,
      from_state text, to_state text NOT NULL, action text NOT NULL, actor_id uuid,
      payload jsonb NOT NULL DEFAULT '{}'::jsonb, occurred_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX idx_workflow_actions_instance ON workflow_actions (organization_id, instance_id, occurred_at);
    CREATE TABLE workflow_failures (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      instance_id uuid NOT NULL REFERENCES workflow_instances(id) ON DELETE CASCADE,
      action text NOT NULL, error text NOT NULL, status text NOT NULL DEFAULT 'open',
      occurred_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz
    );
    CREATE INDEX idx_workflow_failures_org ON workflow_failures (organization_id, status);
  `);
  for (const t of ['team_membership_history', 'task_activity', 'workflow_actions']) await appendOnly(knex, t);
  for (const t of TABLES) await enableTenantRls(knex, t);
  await grantApp(knex, TABLES.filter((t) => !['team_membership_history', 'task_activity', 'workflow_actions'].includes(t)));
  await grantApp(knex, ['team_membership_history', 'task_activity', 'workflow_actions'], 'SELECT, INSERT');
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS ${[...TABLES].reverse().join(', ')} CASCADE`);
}
