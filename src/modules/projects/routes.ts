import { z } from 'zod';
import { defineRoute, type HandlerCtx } from '../../platform/http/route.js';
import { AppError } from '../../platform/errors.js';
import { newId } from '../../platform/crypto.js';
import { crudResource, rowToApi, mapDbError, inputToDb } from '../../platform/crud.js';
import { paginate, listQuerySchema, type ListQuery } from '../../platform/pagination.js';
import { jobRegistrars } from '../../platform/job-handlers.js';
import { withPlatformScope, withTenant } from '../../platform/scope.js';
import { transitionAllowed } from '../workflow/routes.js';
import { membershipFor } from '../iam/service.js';
import { registerWidget } from '../dashboard/registry.js';
import type { Trx } from '../../platform/scope.js';

const M = 'projects';
const FLAG = 'module.projects';
const obj = z.record(z.string(), z.unknown());
const uuid = z.string().uuid();
const idParams = z.object({ id: uuid });
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const LEVEL = { viewer: 1, contributor: 2, lead: 3 } as const;

/** Project RBAC on top of org RBAC: managers see everything; others need project membership (or ownership). */
async function projectAccess(c: HandlerCtx, projectId: string, need: keyof typeof LEVEL) {
  const p = await c.trx('projects').where({ id: projectId, organization_id: c.orgId() }).whereNull('deleted_at').first();
  if (!p) throw new AppError('NOT_FOUND', 'Project not found');
  if (c.auth!.permissions.has('projects:manage_all')) return p;
  if (p.owner_id === c.auth!.userId) return p;
  const m = await c.trx('project_members').where({ project_id: projectId, user_id: c.auth!.userId }).first();
  if (!m) throw new AppError('NOT_FOUND', 'Project not found'); // do not reveal existence
  if (LEVEL[m.role as keyof typeof LEVEL] < LEVEL[need]) throw new AppError('FORBIDDEN', 'Your project role does not allow this action');
  return p;
}

async function loadTask(c: HandlerCtx, taskId: string, need: keyof typeof LEVEL) {
  const t = await c.trx('tasks').where({ id: taskId, organization_id: c.orgId() }).whereNull('deleted_at').first();
  if (!t) throw new AppError('NOT_FOUND', 'Task not found');
  await projectAccess(c, t.project_id, need);
  return t;
}

const activity = (trx: Trx, orgId: string, actorId: string | null, task: { id: string; project_id: string }, action: string, changes: Record<string, unknown> = {}) =>
  trx('task_activity').insert({ id: newId(), organization_id: orgId, task_id: task.id, project_id: task.project_id, actor_id: actorId, action, changes: JSON.stringify(changes) });

// ---- projects -------------------------------------------------------------------------------------------------

crudResource({
  module: M, moduleFlag: FLAG, path: '/projects', table: 'projects', resource: 'projects', softDelete: true, rowVersion: true,
  create: z.object({
    name: z.string().trim().min(2).max(160), description: z.string().max(5000).default(''), code: z.string().max(20).nullable().optional(),
    status: z.enum(['planning', 'active', 'on_hold', 'completed', 'archived']).default('planning'),
    ownerId: uuid.nullable().optional(), startDate: date.nullable().optional(), endDate: date.nullable().optional(),
    budgetHours: z.number().min(0).max(1_000_000).nullable().optional(),
  }),
  list: {
    sortable: { name: 'projects.name', created_at: 'projects.created_at', end_date: 'projects.end_date' },
    filterable: { status: 'projects.status', owner_id: 'projects.owner_id' }, defaultSort: 'name',
  },
  searchColumns: ['projects.name', 'projects.code'],
  createEntitlement: {
    key: 'max_projects',
    count: async ({ trx, orgId }) => Number(((await trx('projects').where({ organization_id: orgId }).whereNull('deleted_at').count({ c: '*' }).first()) as { c: string }).c),
  },
  hooks: {
    scope(c, qb) {
      if (c.auth!.permissions.has('projects:manage_all')) return;
      qb.where((w) => w.where('projects.owner_id', c.auth!.userId)
        .orWhereIn('projects.id', c.trx('project_members').select('project_id').where('user_id', c.auth!.userId)));
    },
    async beforeCreate(c, trx, input) {
      const o = (input as { ownerId?: string | null }).ownerId;
      if (o && !(await membershipFor(trx, c.orgId(), o))) throw new AppError('VALIDATION_FAILED', 'Owner must be a member', [{ field: 'ownerId', issue: 'not_member' }]);
      return { owner_id: o ?? c.auth!.userId };
    },
    async afterCreate(c, trx, row) {
      await trx('project_members').insert({ id: newId(), organization_id: c.orgId(), project_id: row.id, user_id: row.owner_id, role: 'lead', created_by: c.auth!.userId }).onConflict().ignore();
    },
  },
});

defineRoute({
  method: 'get', path: '/projects/:id/members', module: M, moduleFlag: FLAG, summary: 'Project members',
  access: { permission: 'projects:read' }, params: idParams, response: obj,
  async handler(c) {
    await projectAccess(c, c.params.id, 'viewer');
    const rows = await c.trx('project_members as pm').join('users as u', 'u.id', 'pm.user_id').where('pm.project_id', c.params.id)
      .select('u.id as user_id', 'u.name', 'u.email', 'pm.role');
    return { data: rows.map((r) => rowToApi(r)) };
  },
});

defineRoute({
  method: 'put', path: '/projects/:id/members/:userId', module: M, moduleFlag: FLAG, summary: 'Add or change a project member role',
  access: { permission: 'projects:update' }, params: z.object({ id: uuid, userId: uuid }),
  body: z.object({ role: z.enum(['lead', 'contributor', 'viewer']) }), response: obj,
  audit: { action: 'project.member_set', resourceType: 'project' },
  async handler(c) {
    await projectAccess(c, c.params.id, 'lead');
    const m = await membershipFor(c.trx, c.orgId(), c.params.userId);
    if (!m || m.status !== 'active') throw new AppError('VALIDATION_FAILED', 'User must be an active member', [{ field: 'userId', issue: 'not_member' }]);
    await c.trx('project_members').insert({
      id: newId(), organization_id: c.orgId(), project_id: c.params.id, user_id: c.params.userId, role: c.body.role, created_by: c.auth!.userId,
    }).onConflict(['project_id', 'user_id']).merge({ role: c.body.role });
    return { status: 200, data: { projectId: c.params.id, userId: c.params.userId, role: c.body.role }, auditResourceId: c.params.id };
  },
});

defineRoute({
  method: 'delete', path: '/projects/:id/members/:userId', module: M, moduleFlag: FLAG, summary: 'Remove a project member',
  access: { permission: 'projects:update' }, params: z.object({ id: uuid, userId: uuid }),
  audit: { action: 'project.member_removed', resourceType: 'project' },
  async handler(c) {
    const p = await projectAccess(c, c.params.id, 'lead');
    if (p.owner_id === c.params.userId) throw new AppError('CONFLICT', 'The project owner cannot be removed');
    const n = await c.trx('project_members').where({ project_id: c.params.id, user_id: c.params.userId }).delete();
    if (!n) throw new AppError('NOT_FOUND', 'Project member not found');
    return { status: 204, auditResourceId: c.params.id };
  },
});

// ---- milestones -------------------------------------------------------------------------------------------------

defineRoute({
  method: 'get', path: '/projects/:id/milestones', module: M, moduleFlag: FLAG, summary: 'List milestones',
  access: { permission: 'milestones:read' }, params: idParams, response: obj,
  async handler(c) {
    await projectAccess(c, c.params.id, 'viewer');
    const rows = await c.trx('milestones').where({ project_id: c.params.id, organization_id: c.orgId() }).whereNull('deleted_at').orderBy('due_date');
    return { data: rows.map((r) => rowToApi(r)) };
  },
});

defineRoute({
  method: 'post', path: '/projects/:id/milestones', module: M, moduleFlag: FLAG, summary: 'Create a milestone',
  access: { permission: 'milestones:create' }, params: idParams,
  body: z.object({ name: z.string().trim().min(2).max(160), dueDate: date.nullable().optional() }), response: obj,
  audit: { action: 'milestone.created', resourceType: 'milestone' },
  async handler(c) {
    await projectAccess(c, c.params.id, 'contributor');
    const id = newId();
    await c.trx('milestones').insert({ id, organization_id: c.orgId(), project_id: c.params.id, name: c.body.name, due_date: c.body.dueDate ?? null, created_by: c.auth!.userId, updated_by: c.auth!.userId });
    return { status: 201, data: { id, ...c.body } };
  },
});

defineRoute({
  method: 'patch', path: '/milestones/:id', module: M, moduleFlag: FLAG, summary: 'Update a milestone',
  access: { permission: 'milestones:update' }, params: idParams,
  body: z.object({ name: z.string().trim().min(2).max(160).optional(), dueDate: date.nullable().optional(), status: z.enum(['open', 'reached', 'missed']).optional() }),
  response: obj, audit: { action: 'milestone.updated', resourceType: 'milestone' },
  async handler(c) {
    const m = await c.trx('milestones').where({ id: c.params.id, organization_id: c.orgId() }).whereNull('deleted_at').first();
    if (!m) throw new AppError('NOT_FOUND', 'Milestone not found');
    await projectAccess(c, m.project_id, 'contributor');
    if (Object.keys(c.body).length === 0) throw new AppError('VALIDATION_FAILED', 'No fields to update');
    await c.trx('milestones').where({ id: m.id }).update({ ...inputToDb(c.body), updated_at: c.svc.now(), updated_by: c.auth!.userId, row_version: c.trx.raw('row_version + 1') });
    return { status: 200, data: rowToApi(await c.trx('milestones').where({ id: m.id }).first()) };
  },
});

// ---- tasks -------------------------------------------------------------------------------------------------------

const STATUSES = ['todo', 'in_progress', 'in_review', 'done', 'cancelled'] as const;
const DEFAULT_TRANSITIONS: Record<string, string[]> = {
  todo: ['in_progress', 'cancelled'], in_progress: ['in_review', 'done', 'todo', 'cancelled'],
  in_review: ['done', 'in_progress', 'cancelled'], done: ['in_progress'], cancelled: ['todo'],
};

const taskBody = z.object({
  title: z.string().trim().min(1).max(300), description: z.string().max(20000).default(''),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).default('medium'),
  assigneeId: uuid.nullable().optional(), dueDate: date.nullable().optional(),
  estimateHours: z.number().min(0).max(10000).nullable().optional(),
  parentTaskId: uuid.nullable().optional(), milestoneId: uuid.nullable().optional(),
});

async function validateTaskRefs(c: HandlerCtx, projectId: string, b: { assigneeId?: string | null; parentTaskId?: string | null; milestoneId?: string | null }) {
  if (b.assigneeId) {
    const m = await membershipFor(c.trx, c.orgId(), b.assigneeId);
    if (!m || m.status !== 'active') throw new AppError('VALIDATION_FAILED', 'Assignee must be an active member', [{ field: 'assigneeId', issue: 'not_member' }]);
  }
  if (b.parentTaskId) {
    const p = await c.trx('tasks').where({ id: b.parentTaskId, project_id: projectId, organization_id: c.orgId() }).whereNull('deleted_at').first();
    if (!p) throw new AppError('VALIDATION_FAILED', 'Parent task not found in this project', [{ field: 'parentTaskId', issue: 'not_found' }]);
  }
  if (b.milestoneId) {
    const m = await c.trx('milestones').where({ id: b.milestoneId, project_id: projectId, organization_id: c.orgId() }).whereNull('deleted_at').first();
    if (!m) throw new AppError('VALIDATION_FAILED', 'Milestone not found in this project', [{ field: 'milestoneId', issue: 'not_found' }]);
  }
}

const taskQuery = listQuerySchema.extend({
  status: z.enum(STATUSES).optional(), priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
  assigneeId: uuid.optional(), dueFrom: date.optional(), dueTo: date.optional(),
});

defineRoute({
  method: 'get', path: '/projects/:id/tasks', module: M, moduleFlag: FLAG, summary: 'Task list (filters: status, assignee, priority, due range)',
  access: { permission: 'tasks:read' }, params: idParams, query: taskQuery, response: obj,
  async handler(c) {
    await projectAccess(c, c.params.id, 'viewer');
    const q = c.query as z.infer<typeof taskQuery>;
    const qb = c.trx('tasks').where({ project_id: c.params.id, organization_id: c.orgId() }).whereNull('deleted_at').select('tasks.*');
    if (q.status) qb.where({ status: q.status });
    if (q.priority) qb.where({ priority: q.priority });
    if (q.assigneeId) qb.where({ assignee_id: q.assigneeId });
    if (q.dueFrom) qb.where('due_date', '>=', q.dueFrom);
    if (q.dueTo) qb.where('due_date', '<=', q.dueTo);
    if (q.q) qb.whereILike('title', `%${q.q.replace(/[%_\\]/g, '\\$&')}%`);
    const page = await paginate(qb, q as ListQuery, {
      sortable: { created_at: 'created_at', due_date: 'due_date', priority: 'priority', position: 'position', title: 'title' }, defaultSort: 'position',
    });
    return { data: page.data.map((r) => rowToApi(r)), meta: page.meta };
  },
});

defineRoute({
  method: 'post', path: '/projects/:id/tasks', module: M, moduleFlag: FLAG, summary: 'Create a task',
  access: { permission: 'tasks:create' }, params: idParams, body: taskBody, response: obj,
  audit: { action: 'task.created', resourceType: 'task' },
  async handler(c) {
    await projectAccess(c, c.params.id, 'contributor');
    await validateTaskRefs(c, c.params.id, c.body);
    const last = await c.trx('tasks').where({ project_id: c.params.id, status: 'todo', organization_id: c.orgId() }).max({ p: 'position' }).first();
    const id = newId();
    await c.trx('tasks').insert({
      ...inputToDb(c.body), id, organization_id: c.orgId(), project_id: c.params.id, status: 'todo',
      position: Number((last as { p: number | null }).p ?? 0) + 1024, created_by: c.auth!.userId, updated_by: c.auth!.userId,
    });
    const t = await c.trx('tasks').where({ id }).first();
    await activity(c.trx, c.orgId(), c.auth!.userId, t, 'created', { title: c.body.title });
    await c.emit('task.created', { taskId: id, projectId: c.params.id });
    if (t.assignee_id) await c.emit('task.assigned', { taskId: id, assigneeId: t.assignee_id, title: t.title });
    return { status: 201, data: rowToApi(t) };
  },
});

defineRoute({
  method: 'get', path: '/tasks/:id', module: M, moduleFlag: FLAG, summary: 'Get a task with subtasks and dependencies',
  access: { permission: 'tasks:read' }, params: idParams, response: obj,
  async handler(c) {
    const t = await loadTask(c, c.params.id, 'viewer');
    const subtasks = await c.trx('tasks').where({ parent_task_id: t.id }).whereNull('deleted_at').orderBy('position');
    const deps = await c.trx('task_dependencies').where({ task_id: t.id }).select('depends_on_task_id');
    return { data: { ...rowToApi(t), subtasks: subtasks.map((s) => rowToApi(s)), dependsOn: deps.map((d) => d.depends_on_task_id) } };
  },
});

defineRoute({
  method: 'patch', path: '/tasks/:id', module: M, moduleFlag: FLAG, summary: 'Update a task',
  access: { permission: 'tasks:update' }, params: idParams, body: taskBody.partial().extend({ rowVersion: z.number().int().optional() }),
  response: obj, audit: { action: 'task.updated', resourceType: 'task' },
  async handler(c) {
    const t = await loadTask(c, c.params.id, 'contributor');
    const { rowVersion, ...patch } = c.body;
    if (rowVersion !== undefined && rowVersion !== t.row_version) throw new AppError('PRECONDITION_FAILED', 'The task was modified by someone else; reload and retry');
    if (Object.keys(patch).length === 0) throw new AppError('VALIDATION_FAILED', 'No fields to update');
    await validateTaskRefs(c, t.project_id, patch);
    if (patch.parentTaskId === t.id) throw new AppError('CONFLICT', 'A task cannot be its own parent');
    await c.trx('tasks').where({ id: t.id }).update({ ...inputToDb(patch), updated_at: c.svc.now(), updated_by: c.auth!.userId, row_version: c.trx.raw('row_version + 1') });
    const updated = await c.trx('tasks').where({ id: t.id }).first();
    const changes: Record<string, unknown> = {};
    for (const k of Object.keys(patch)) { const col = k.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`); changes[k] = { from: t[col], to: updated[col] }; }
    await activity(c.trx, c.orgId(), c.auth!.userId, t, 'updated', changes);
    if (patch.assigneeId && patch.assigneeId !== t.assignee_id) await c.emit('task.assigned', { taskId: t.id, assigneeId: patch.assigneeId, title: updated.title });
    return { status: 200, data: rowToApi(updated) };
  },
});

defineRoute({
  method: 'delete', path: '/tasks/:id', module: M, moduleFlag: FLAG, summary: 'Delete a task (soft)',
  access: { permission: 'tasks:delete' }, params: idParams, audit: { action: 'task.deleted', resourceType: 'task' },
  async handler(c) {
    const t = await loadTask(c, c.params.id, 'contributor');
    await c.trx('tasks').where({ id: t.id }).update({ deleted_at: c.svc.now(), deleted_by: c.auth!.userId });
    await activity(c.trx, c.orgId(), c.auth!.userId, t, 'deleted');
    return { status: 204, auditResourceId: t.id };
  },
});

defineRoute({
  method: 'patch', path: '/tasks/:id/move', module: M, moduleFlag: FLAG, summary: 'Move a task between columns / reorder (Kanban)',
  access: { permission: 'tasks:update' }, params: idParams,
  body: z.object({ status: z.enum(STATUSES).optional(), afterTaskId: uuid.nullable().optional(), rowVersion: z.number().int().optional() }),
  response: obj, audit: { action: 'task.moved', resourceType: 'task' },
  async handler(c) {
    const t = await loadTask(c, c.params.id, 'contributor');
    if (c.body.rowVersion !== undefined && c.body.rowVersion !== t.row_version) throw new AppError('PRECONDITION_FAILED', 'The task was modified by someone else; reload and retry');
    const target = c.body.status ?? t.status;
    if (target !== t.status) {
      const configured = await transitionAllowed(c.trx, c.orgId(), 'task', t.status, target, { task: t }, c.auth!.permissions);
      const ok = configured ?? DEFAULT_TRANSITIONS[t.status]!.includes(target);
      if (!ok) throw new AppError('CONFLICT', `Cannot move a task from "${t.status}" to "${target}"`);
      if (target === 'done') {
        const open = await c.trx('task_dependencies as d').join('tasks as dep', 'dep.id', 'd.depends_on_task_id')
          .where('d.task_id', t.id).whereNull('dep.deleted_at').whereNotIn('dep.status', ['done', 'cancelled']).first('dep.id');
        if (open) throw new AppError('CONFLICT', 'Task is blocked by unfinished dependencies');
      }
    }
    // fractional ordering: place between `afterTaskId` and its successor in the target column
    const col = c.trx('tasks').where({ project_id: t.project_id, organization_id: c.orgId(), status: target }).whereNull('deleted_at').whereNot('id', t.id);
    let position: number;
    if (c.body.afterTaskId) {
      const after = await c.trx('tasks').where({ id: c.body.afterTaskId, project_id: t.project_id, status: target }).first();
      if (!after) throw new AppError('VALIDATION_FAILED', 'afterTaskId is not in the target column', [{ field: 'afterTaskId', issue: 'not_found' }]);
      const next = await col.clone().where('position', '>', after.position).orderBy('position').first('position');
      position = next ? (after.position + next.position) / 2 : after.position + 1024;
    } else if (c.body.afterTaskId === null) {
      const first = await col.clone().orderBy('position').first('position');
      position = first ? first.position / 2 : 1024;
    } else {
      const last = await col.clone().max({ p: 'position' }).first();
      position = target === t.status ? t.position : Number((last as { p: number | null }).p ?? 0) + 1024;
    }
    await c.trx('tasks').where({ id: t.id }).update({
      status: target, position, completed_at: target === 'done' ? c.svc.now() : null,
      updated_at: c.svc.now(), updated_by: c.auth!.userId, row_version: c.trx.raw('row_version + 1'),
    });
    await activity(c.trx, c.orgId(), c.auth!.userId, t, 'moved', { status: { from: t.status, to: target } });
    if (target !== t.status) await c.emit('task.status_changed', { taskId: t.id, from: t.status, to: target });
    return { status: 200, data: rowToApi(await c.trx('tasks').where({ id: t.id }).first()) };
  },
});

defineRoute({
  method: 'get', path: '/projects/:id/board', module: M, moduleFlag: FLAG, summary: 'Kanban board grouped by status',
  access: { permission: 'tasks:read' }, params: idParams, response: obj,
  async handler(c) {
    await projectAccess(c, c.params.id, 'viewer');
    const rows = await c.trx('tasks').where({ project_id: c.params.id, organization_id: c.orgId() }).whereNull('deleted_at').orderBy('position');
    const columns = STATUSES.map((s) => ({ status: s, tasks: rows.filter((r) => r.status === s).map((r) => rowToApi(r)) }));
    return { data: { columns } };
  },
});

// ---- comments, attachments, dependencies, activity -------------------------------------------------------------------

defineRoute({
  method: 'post', path: '/tasks/:id/comments', module: M, moduleFlag: FLAG, summary: 'Comment on a task',
  access: { permission: 'tasks:comment' }, params: idParams, body: z.object({ body: z.string().trim().min(1).max(5000) }), response: obj,
  audit: { action: 'task.commented', resourceType: 'task' },
  async handler(c) {
    const t = await loadTask(c, c.params.id, 'viewer');
    const id = newId();
    await c.trx('task_comments').insert({ id, organization_id: c.orgId(), task_id: t.id, author_id: c.auth!.userId, body: c.body.body });
    await activity(c.trx, c.orgId(), c.auth!.userId, t, 'commented');
    await c.emit('task.commented', { taskId: t.id, commentId: id });
    return { status: 201, data: { id, body: c.body.body }, auditResourceId: t.id };
  },
});

defineRoute({
  method: 'get', path: '/tasks/:id/comments', module: M, moduleFlag: FLAG, summary: 'List comments',
  access: { permission: 'tasks:read' }, params: idParams, response: obj,
  async handler(c) {
    const t = await loadTask(c, c.params.id, 'viewer');
    const rows = await c.trx('task_comments as tc').join('users as u', 'u.id', 'tc.author_id').where({ 'tc.task_id': t.id }).whereNull('tc.deleted_at')
      .orderBy('tc.created_at').select('tc.id', 'tc.body', 'tc.created_at', 'u.id as author_id', 'u.name as author_name');
    return { data: rows.map((r) => rowToApi(r)) };
  },
});

defineRoute({
  method: 'delete', path: '/tasks/:id/comments/:commentId', module: M, moduleFlag: FLAG, summary: 'Delete my comment',
  access: { permission: 'tasks:comment' }, params: z.object({ id: uuid, commentId: uuid }),
  async handler(c) {
    const t = await loadTask(c, c.params.id, 'viewer');
    const n = await c.trx('task_comments').where({ id: c.params.commentId, task_id: t.id, author_id: c.auth!.userId }).whereNull('deleted_at').update({ deleted_at: c.svc.now() });
    if (!n) throw new AppError('NOT_FOUND', 'Comment not found');
    return { status: 204 };
  },
});

defineRoute({
  method: 'post', path: '/tasks/:id/attachments', module: M, moduleFlag: FLAG, summary: 'Attach an uploaded file',
  access: { permission: 'tasks:update' }, params: idParams, body: z.object({ fileId: uuid }), response: obj,
  audit: { action: 'task.attachment_added', resourceType: 'task' },
  async handler(c) {
    const t = await loadTask(c, c.params.id, 'contributor');
    const f = await c.trx('files').where({ id: c.body.fileId, organization_id: c.orgId() }).whereNull('deleted_at').first();
    if (!f) throw new AppError('VALIDATION_FAILED', 'File not found', [{ field: 'fileId', issue: 'not_found' }]);
    const id = newId();
    try { await c.trx('task_attachments').insert({ id, organization_id: c.orgId(), task_id: t.id, file_id: f.id, created_by: c.auth!.userId }); }
    catch (e) { throw mapDbError(e); }
    await activity(c.trx, c.orgId(), c.auth!.userId, t, 'attachment_added', { fileId: f.id });
    return { status: 201, data: { id, fileId: f.id }, auditResourceId: t.id };
  },
});

defineRoute({
  method: 'get', path: '/tasks/:id/attachments', module: M, moduleFlag: FLAG, summary: 'List attachments',
  access: { permission: 'tasks:read' }, params: idParams, response: obj,
  async handler(c) {
    const t = await loadTask(c, c.params.id, 'viewer');
    const rows = await c.trx('task_attachments as a').join('files as f', 'f.id', 'a.file_id').where('a.task_id', t.id).whereNull('f.deleted_at')
      .select('a.id', 'f.id as file_id', 'f.original_filename', 'f.content_type', 'f.size', 'f.scan_status');
    return { data: rows.map((r) => rowToApi(r)) };
  },
});

defineRoute({
  method: 'post', path: '/tasks/:id/dependencies', module: M, moduleFlag: FLAG, summary: 'Add a dependency (cycles rejected)',
  access: { permission: 'tasks:update' }, params: idParams, body: z.object({ dependsOnTaskId: uuid }), response: obj,
  audit: { action: 'task.dependency_added', resourceType: 'task' },
  async handler(c) {
    const t = await loadTask(c, c.params.id, 'contributor');
    const dep = await loadTask(c, c.body.dependsOnTaskId, 'viewer');
    if (dep.id === t.id) throw new AppError('CONFLICT', 'A task cannot depend on itself');
    const cyc = await c.trx.raw(
      `WITH RECURSIVE chain AS (
         SELECT depends_on_task_id AS id FROM task_dependencies WHERE task_id = ? AND organization_id = ?
         UNION SELECT d.depends_on_task_id FROM task_dependencies d JOIN chain ON d.task_id = chain.id)
       SELECT 1 FROM chain WHERE id = ?`, [dep.id, c.orgId(), t.id]);
    if (cyc.rows.length > 0) throw new AppError('CONFLICT', 'This dependency would create a cycle');
    try { await c.trx('task_dependencies').insert({ id: newId(), organization_id: c.orgId(), task_id: t.id, depends_on_task_id: dep.id, created_by: c.auth!.userId }); }
    catch (e) { throw mapDbError(e); }
    return { status: 201, data: { taskId: t.id, dependsOnTaskId: dep.id }, auditResourceId: t.id };
  },
});

defineRoute({
  method: 'delete', path: '/tasks/:id/dependencies/:dependsOnTaskId', module: M, moduleFlag: FLAG, summary: 'Remove a dependency',
  access: { permission: 'tasks:update' }, params: z.object({ id: uuid, dependsOnTaskId: uuid }),
  async handler(c) {
    const t = await loadTask(c, c.params.id, 'contributor');
    const n = await c.trx('task_dependencies').where({ task_id: t.id, depends_on_task_id: c.params.dependsOnTaskId }).delete();
    if (!n) throw new AppError('NOT_FOUND', 'Dependency not found');
    return { status: 204 };
  },
});

defineRoute({
  method: 'get', path: '/tasks/:id/activity', module: M, moduleFlag: FLAG, summary: 'Append-only task activity',
  access: { permission: 'tasks:read' }, params: idParams, query: listQuerySchema, response: obj,
  async handler(c) {
    const t = await loadTask(c, c.params.id, 'viewer');
    const page = await paginate(c.trx('task_activity').where({ organization_id: c.orgId(), task_id: t.id }), c.query as ListQuery, { sortable: { occurred_at: 'occurred_at' }, defaultSort: '-occurred_at' });
    return { data: page.data.map((r) => rowToApi(r)), meta: page.meta };
  },
});

// ---- recurring tasks (F-203) ---------------------------------------------------------------------------------------

const recurringBody = z.object({
  title: z.string().trim().min(1).max(300), description: z.string().max(5000).default(''),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).default('medium'), assigneeId: uuid.nullable().optional(),
  frequency: z.enum(['daily', 'weekly', 'monthly']), intervalCount: z.number().int().min(1).max(52).default(1),
  nextRunOn: date, endOn: date.nullable().optional(), estimateHours: z.number().min(0).max(1000).nullable().optional(),
});

defineRoute({
  method: 'post', path: '/projects/:id/recurring-rules', module: M, moduleFlag: FLAG, summary: 'Create a recurring task rule',
  access: { permission: 'tasks:create' }, params: idParams, body: recurringBody, response: obj,
  audit: { action: 'recurring_rule.created', resourceType: 'recurring_rule' },
  async handler(c) {
    await projectAccess(c, c.params.id, 'lead');
    const id = newId();
    await c.trx('recurring_task_rules').insert({ ...inputToDb(c.body), id, organization_id: c.orgId(), project_id: c.params.id, created_by: c.auth!.userId, updated_by: c.auth!.userId });
    return { status: 201, data: { id, ...c.body } };
  },
});

defineRoute({
  method: 'get', path: '/projects/:id/recurring-rules', module: M, moduleFlag: FLAG, summary: 'List recurring rules',
  access: { permission: 'tasks:read' }, params: idParams, response: obj,
  async handler(c) {
    await projectAccess(c, c.params.id, 'viewer');
    return { data: (await c.trx('recurring_task_rules').where({ project_id: c.params.id, organization_id: c.orgId() }).orderBy('created_at')).map((r) => rowToApi(r)) };
  },
});

defineRoute({
  method: 'delete', path: '/recurring-rules/:id', module: M, moduleFlag: FLAG, summary: 'Deactivate a recurring rule',
  access: { permission: 'tasks:delete' }, params: idParams,
  async handler(c) {
    const r = await c.trx('recurring_task_rules').where({ id: c.params.id, organization_id: c.orgId() }).first();
    if (!r) throw new AppError('NOT_FOUND', 'Rule not found');
    await projectAccess(c, r.project_id, 'lead');
    await c.trx('recurring_task_rules').where({ id: r.id }).update({ active: false });
    return { status: 204 };
  },
});

function nextRun(from: string, freq: string, interval: number): string {
  const d = new Date(`${from}T00:00:00Z`);
  if (freq === 'daily') d.setUTCDate(d.getUTCDate() + interval);
  else if (freq === 'weekly') d.setUTCDate(d.getUTCDate() + 7 * interval);
  else d.setUTCMonth(d.getUTCMonth() + interval);
  return d.toISOString().slice(0, 10);
}

/** Idempotent per (rule, occurrence date): safe to run repeatedly or concurrently. */
export async function materializeRecurring(db: import('knex').Knex, today: string): Promise<number> {
  const due = await withPlatformScope(db, 'recurring-due', (t) => t('recurring_task_rules').where({ active: true }).where('next_run_on', '<=', today));
  let created = 0;
  for (const rule of due) {
    await withTenant(db, { organizationId: rule.organization_id, userId: null }, async (trx) => {
      let next: string = rule.next_run_on instanceof Date ? rule.next_run_on.toISOString().slice(0, 10) : rule.next_run_on;
      let guard = 0;
      while (next <= today && guard++ < 366) {
        const end = rule.end_on ? (rule.end_on instanceof Date ? rule.end_on.toISOString().slice(0, 10) : rule.end_on) : null;
        if (end && next > end) { await trx('recurring_task_rules').where({ id: rule.id }).update({ active: false }); return; }
        const ins = await trx('recurring_task_occurrences').insert({ id: newId(), organization_id: rule.organization_id, rule_id: rule.id, occurrence_date: next })
          .onConflict(['rule_id', 'occurrence_date']).ignore().returning('id');
        if (ins.length > 0) {
          const taskId = newId();
          await trx('tasks').insert({
            id: taskId, organization_id: rule.organization_id, project_id: rule.project_id, title: rule.title, description: rule.description,
            priority: rule.priority, assignee_id: rule.assignee_id, due_date: next, estimate_hours: rule.estimate_hours,
            position: Date.now(), created_by: rule.created_by, updated_by: rule.created_by,
          });
          await trx('recurring_task_occurrences').where({ rule_id: rule.id, occurrence_date: next }).update({ task_id: taskId });
          created++;
        }
        next = nextRun(next, rule.frequency, rule.interval_count);
      }
      await trx('recurring_task_rules').where({ id: rule.id }).update({ next_run_on: next });
    });
  }
  return created;
}

jobRegistrars.push((svc) => {
  svc.jobs.work('reminders', async () => {
    await materializeRecurring(svc.db, svc.now().toISOString().slice(0, 10));
  });
});

// ---- templates (F-205) ---------------------------------------------------------------------------------------------

crudResource({
  module: M, moduleFlag: FLAG, path: '/project-templates', table: 'project_templates', resource: 'project_templates', softDelete: true, rowVersion: true,
  create: z.object({ name: z.string().trim().min(2).max(160), description: z.string().max(2000).default('') }),
  list: { sortable: { name: 'project_templates.name', created_at: 'project_templates.created_at' }, defaultSort: 'name' },
});

defineRoute({
  method: 'get', path: '/project-templates/:id/tasks', module: M, moduleFlag: FLAG, summary: 'List the tasks of a template',
  access: { permission: 'project_templates:read' }, params: idParams, response: obj,
  async handler(c) {
    const tpl = await c.trx('project_templates').where({ id: c.params.id, organization_id: c.orgId() }).whereNull('deleted_at').first();
    if (!tpl) throw new AppError('NOT_FOUND', 'Template not found');
    const rows = await c.trx('project_template_tasks').where({ template_id: tpl.id, organization_id: c.orgId() }).orderBy('position');
    return {
      data: rows.map((r) => ({
        id: r.id, title: r.title, description: r.description, priority: r.priority,
        offsetDays: r.offset_days, estimateHours: r.estimate_hours === null ? null : Number(r.estimate_hours), position: r.position,
      })),
    };
  },
});

defineRoute({
  method: 'put', path: '/project-templates/:id/tasks', module: M, moduleFlag: FLAG, summary: 'Replace the task list of a template',
  access: { permission: 'project_templates:update' }, params: idParams,
  body: z.object({ tasks: z.array(z.object({
    title: z.string().trim().min(1).max(300), description: z.string().max(5000).default(''),
    priority: z.enum(['low', 'medium', 'high', 'urgent']).default('medium'), offsetDays: z.number().int().min(0).max(3650).default(0),
    estimateHours: z.number().min(0).max(1000).nullable().optional(),
  })).max(500) }), response: obj,
  async handler(c) {
    const tpl = await c.trx('project_templates').where({ id: c.params.id, organization_id: c.orgId() }).whereNull('deleted_at').first();
    if (!tpl) throw new AppError('NOT_FOUND', 'Template not found');
    await c.trx('project_template_tasks').where({ template_id: tpl.id }).delete();
    if (c.body.tasks.length) {
      await c.trx('project_template_tasks').insert(c.body.tasks.map((t, i) => ({
        id: newId(), organization_id: c.orgId(), template_id: tpl.id, title: t.title, description: t.description,
        priority: t.priority, offset_days: t.offsetDays, position: i, estimate_hours: t.estimateHours ?? null,
      })));
    }
    return { status: 200, data: { templateId: tpl.id, tasks: c.body.tasks.length } };
  },
});

defineRoute({
  method: 'post', path: '/projects/from-template', module: M, moduleFlag: FLAG, summary: 'Create a project from a template',
  access: { permission: 'projects:create' }, idempotent: true,
  body: z.object({ templateId: uuid, name: z.string().trim().min(2).max(160), startDate: date }), response: obj,
  audit: { action: 'project.created_from_template', resourceType: 'project' },
  async handler(c) {
    const tpl = await c.trx('project_templates').where({ id: c.body.templateId, organization_id: c.orgId() }).whereNull('deleted_at').first();
    if (!tpl) throw new AppError('NOT_FOUND', 'Template not found');
    const id = newId();
    try {
      await c.trx('projects').insert({
        id, organization_id: c.orgId(), name: c.body.name, description: tpl.description, status: 'planning', owner_id: c.auth!.userId,
        start_date: c.body.startDate, template_id: tpl.id, created_by: c.auth!.userId, updated_by: c.auth!.userId,
      });
    } catch (e) { throw mapDbError(e); }
    await c.trx('project_members').insert({ id: newId(), organization_id: c.orgId(), project_id: id, user_id: c.auth!.userId, role: 'lead', created_by: c.auth!.userId });
    const tasks = await c.trx('project_template_tasks').where({ template_id: tpl.id }).orderBy('position');
    for (const [i, t] of tasks.entries()) {
      const due = new Date(`${c.body.startDate}T00:00:00Z`);
      due.setUTCDate(due.getUTCDate() + t.offset_days);
      await c.trx('tasks').insert({
        id: newId(), organization_id: c.orgId(), project_id: id, title: t.title, description: t.description, priority: t.priority,
        due_date: due.toISOString().slice(0, 10), estimate_hours: t.estimate_hours, position: (i + 1) * 1024, created_by: c.auth!.userId, updated_by: c.auth!.userId,
      });
    }
    return { status: 201, data: { id, tasks: tasks.length }, auditResourceId: id };
  },
});

// ---- progress & reports (F-068) ------------------------------------------------------------------------------------

defineRoute({
  method: 'get', path: '/projects/:id/progress', module: M, moduleFlag: FLAG, summary: 'Progress: tasks, estimates vs actual hours',
  access: { permission: 'projects:read' }, params: idParams, response: obj,
  async handler(c) {
    const p = await projectAccess(c, c.params.id, 'viewer');
    const rows = (await c.trx('tasks').where({ project_id: p.id, organization_id: c.orgId() }).whereNull('deleted_at')
      .select('status').count({ c: '*' }).sum({ est: 'estimate_hours' }).groupBy('status')) as unknown as { status: string; c: string; est: string | null }[];
    const total = rows.reduce((a, r) => a + Number(r.c), 0);
    const done = Number(rows.find((r) => r.status === 'done')?.c ?? 0);
    const est = rows.reduce((a, r) => a + Number(r.est ?? 0), 0);
    const actual = await c.trx('time_entries').where({ project_id: p.id, organization_id: c.orgId() }).sum({ m: 'minutes' }).first().catch(() => ({ m: 0 }));
    const actualHours = Math.round((Number((actual as { m: string | number | null })?.m ?? 0) / 60) * 100) / 100;
    return {
      data: {
        projectId: p.id, totalTasks: total, doneTasks: done, percentComplete: total ? Math.round((done / total) * 1000) / 10 : 0,
        byStatus: Object.fromEntries(rows.map((r) => [r.status, Number(r.c)])), estimatedHours: est, actualHours,
        budgetHours: p.budget_hours === null ? null : Number(p.budget_hours),
      },
    };
  },
});

defineRoute({
  method: 'get', path: '/projects/:id/reports', module: M, moduleFlag: FLAG, summary: 'Project report: overdue, by assignee, by priority',
  access: { permission: 'projects:read' }, params: idParams, response: obj,
  async handler(c) {
    const p = await projectAccess(c, c.params.id, 'viewer');
    const base = () => c.trx('tasks').where({ project_id: p.id, organization_id: c.orgId() }).whereNull('deleted_at');
    const today = c.svc.now().toISOString().slice(0, 10);
    const overdue = await base().whereNotIn('status', ['done', 'cancelled']).where('due_date', '<', today).count({ c: '*' }).first();
    const byAssignee = (await base().select('assignee_id').count({ c: '*' }).groupBy('assignee_id')) as unknown as { assignee_id: string | null; c: string }[];
    const byPriority = (await base().select('priority').count({ c: '*' }).groupBy('priority')) as unknown as { priority: string; c: string }[];
    return {
      data: {
        overdue: Number((overdue as { c: string }).c),
        byAssignee: byAssignee.map((r) => ({ assigneeId: r.assignee_id, count: Number(r.c) })),
        byPriority: Object.fromEntries(byPriority.map((r) => [r.priority, Number(r.c)])),
      },
    };
  },
});

registerWidget({
  key: 'tasks.my_open', title: 'My open tasks', requiredPermission: 'tasks:read', requiredModuleFlag: FLAG,
  async query({ trx, organizationId, userId }) {
    const r = (await trx('tasks').where({ organization_id: organizationId, assignee_id: userId }).whereNull('deleted_at')
      .whereNotIn('status', ['done', 'cancelled']).select('status').count({ c: '*' }).groupBy('status')) as unknown as { status: string; c: string }[];
    return Object.fromEntries(r.map((x) => [x.status, Number(x.c)]));
  },
});
