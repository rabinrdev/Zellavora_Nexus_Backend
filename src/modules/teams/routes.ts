import { z } from 'zod';
import { defineRoute, type HandlerCtx } from '../../platform/http/route.js';
import { AppError } from '../../platform/errors.js';
import { newId } from '../../platform/crypto.js';
import { crudResource, rowToApi, mapDbError } from '../../platform/crud.js';
import { paginate, listQuerySchema, type ListQuery } from '../../platform/pagination.js';
import { bumpPermissionVersion } from '../../platform/authz.js';
import { getRole, membershipFor } from '../iam/service.js';

const M = 'teams';
const FLAG = 'module.teams';
const obj = z.record(z.string(), z.unknown());
const uuid = z.string().uuid();
const idParams = z.object({ id: uuid });

crudResource({
  module: M, moduleFlag: FLAG, path: '/teams', table: 'teams', resource: 'teams', softDelete: true, rowVersion: true,
  create: z.object({
    name: z.string().trim().min(2).max(120), description: z.string().max(500).default(''), departmentId: uuid.nullable().optional(),
  }),
  list: { sortable: { name: 'teams.name', created_at: 'teams.created_at' }, filterable: { department_id: 'teams.department_id' }, defaultSort: 'name' },
  searchColumns: ['teams.name'],
  hooks: {
    async beforeCreate(c, trx, input) {
      const d = (input as { departmentId?: string | null }).departmentId;
      if (d && !(await trx('departments').where({ id: d, organization_id: c.orgId() }).whereNull('deleted_at').first())) {
        throw new AppError('VALIDATION_FAILED', 'Department not found', [{ field: 'departmentId', issue: 'not_found' }]);
      }
    },
    async beforeUpdate(c, trx, input) {
      const d = (input as { departmentId?: string | null }).departmentId;
      if (d && !(await trx('departments').where({ id: d, organization_id: c.orgId() }).whereNull('deleted_at').first())) {
        throw new AppError('VALIDATION_FAILED', 'Department not found', [{ field: 'departmentId', issue: 'not_found' }]);
      }
    },
  },
});

async function loadTeam(c: HandlerCtx, id: string) {
  const t = await c.trx('teams').where({ id, organization_id: c.orgId() }).whereNull('deleted_at').first();
  if (!t) throw new AppError('NOT_FOUND', 'Team not found');
  return t;
}

const history = (c: HandlerCtx, teamId: string, userId: string, change: string) =>
  c.trx('team_membership_history').insert({ id: newId(), organization_id: c.orgId(), team_id: teamId, user_id: userId, change, actor_id: c.auth!.userId });

async function grantTeamRoles(c: HandlerCtx, team: { id: string; permissions: string[] }, membershipId: string, userId: string) {
  if (!(team.permissions ?? []).length) return; // no team-scoped roles: nothing changes for the user's access
  for (const roleId of team.permissions ?? []) {
    await c.trx('user_role_assignments').insert({
      id: newId(), organization_id: c.orgId(), membership_id: membershipId, role_id: roleId,
      scope_type: 'team', scope_id: team.id, created_by: c.auth!.userId,
    }).onConflict().ignore();
  }
  await bumpPermissionVersion(c.trx, [userId]);
}

defineRoute({
  method: 'get', path: '/teams/:id/members', module: M, moduleFlag: FLAG, summary: 'Team members',
  access: { permission: 'teams:read' }, params: idParams, response: obj,
  async handler(c) {
    await loadTeam(c, c.params.id);
    const rows = await c.trx('team_members as tm').join('users as u', 'u.id', 'tm.user_id')
      .where({ 'tm.team_id': c.params.id, 'tm.organization_id': c.orgId() }).orderBy('u.name')
      .select('u.id as user_id', 'u.name', 'u.email', 'tm.is_leader', 'tm.joined_at');
    return { data: rows.map((r) => rowToApi(r)) };
  },
});

defineRoute({
  method: 'post', path: '/teams/:id/members', module: M, moduleFlag: FLAG, summary: 'Add a member to a team',
  access: { permission: 'teams:update' }, params: idParams, body: z.object({ userId: uuid }), response: obj,
  audit: { action: 'team.member_added', resourceType: 'team' },
  async handler(c) {
    const team = await loadTeam(c, c.params.id);
    const m = await membershipFor(c.trx, c.orgId(), c.body.userId); // users from other organizations can never be added
    if (!m || m.status !== 'active') throw new AppError('VALIDATION_FAILED', 'User must be an active member of the organization', [{ field: 'userId', issue: 'not_member' }]);
    try {
      await c.trx('team_members').insert({ id: newId(), organization_id: c.orgId(), team_id: team.id, user_id: c.body.userId, created_by: c.auth!.userId });
    } catch (e) { throw mapDbError(e); }
    await history(c, team.id, c.body.userId, 'added');
    await grantTeamRoles(c, team, m.id, c.body.userId);
    await c.emit('team.member_added', { teamId: team.id, userId: c.body.userId });
    return { status: 201, data: { teamId: team.id, userId: c.body.userId }, auditResourceId: team.id };
  },
});

defineRoute({
  method: 'delete', path: '/teams/:id/members/:userId', module: M, moduleFlag: FLAG, summary: 'Remove a member from a team',
  access: { permission: 'teams:update' }, params: z.object({ id: uuid, userId: uuid }),
  audit: { action: 'team.member_removed', resourceType: 'team' },
  async handler(c) {
    const team = await loadTeam(c, c.params.id);
    const n = await c.trx('team_members').where({ team_id: team.id, user_id: c.params.userId, organization_id: c.orgId() }).delete();
    if (!n) throw new AppError('NOT_FOUND', 'Team member not found');
    const m = await membershipFor(c.trx, c.orgId(), c.params.userId);
    if (m) await c.trx('user_role_assignments').where({ membership_id: m.id, scope_type: 'team', scope_id: team.id }).delete();
    await history(c, team.id, c.params.userId, 'removed');
    if ((team.permissions as string[] | null)?.length) await bumpPermissionVersion(c.trx, [c.params.userId]);
    return { status: 204, auditResourceId: team.id };
  },
});

defineRoute({
  method: 'put', path: '/teams/:id/leaders', module: M, moduleFlag: FLAG, summary: 'Set team leaders (must be members)',
  access: { permission: 'teams:update' }, params: idParams, body: z.object({ userIds: z.array(uuid).max(20) }), response: obj,
  audit: { action: 'team.leaders_changed', resourceType: 'team' },
  async handler(c) {
    const team = await loadTeam(c, c.params.id);
    const members = await c.trx('team_members').where({ team_id: team.id }).select('user_id');
    const set = new Set(members.map((m) => m.user_id as string));
    const bad = c.body.userIds.filter((u) => !set.has(u));
    if (bad.length) throw new AppError('VALIDATION_FAILED', 'Leaders must be team members', bad.map((b) => ({ field: 'userIds', issue: b })));
    await c.trx('team_members').where({ team_id: team.id }).update({ is_leader: false });
    if (c.body.userIds.length) await c.trx('team_members').where({ team_id: team.id }).whereIn('user_id', c.body.userIds).update({ is_leader: true });
    for (const u of c.body.userIds) await history(c, team.id, u, 'leader_assigned');
    return { status: 200, data: { teamId: team.id, leaders: c.body.userIds }, auditResourceId: team.id };
  },
});

defineRoute({
  method: 'put', path: '/teams/:id/permissions', module: M, moduleFlag: FLAG, summary: 'Set team-scoped roles granted to members',
  access: { permission: 'roles:assign' }, params: idParams, body: z.object({ roleIds: z.array(uuid).max(10) }), response: obj,
  audit: { action: 'team.roles_changed', resourceType: 'team' },
  async handler(c) {
    const team = await loadTeam(c, c.params.id);
    for (const r of c.body.roleIds) {
      const role = await getRole(c.trx, c.orgId(), r);
      const keys = (await c.trx('role_permissions').where({ role_id: role.id }).select('permission_key')).map((x) => x.permission_key as string);
      const missing = keys.filter((k) => !c.auth!.permissions.has(k));
      if (missing.length) throw new AppError('FORBIDDEN', 'You cannot grant permissions you do not hold');
    }
    await c.trx('user_role_assignments').where({ organization_id: c.orgId(), scope_type: 'team', scope_id: team.id }).delete();
    await c.trx('teams').where({ id: team.id }).update({ permissions: JSON.stringify(c.body.roleIds), updated_at: c.svc.now() });
    const members = await c.trx('team_members as tm').join('organization_memberships as m', function () {
      this.on('m.user_id', 'tm.user_id').andOn('m.organization_id', 'tm.organization_id');
    }).where('tm.team_id', team.id).select('m.id as membership_id', 'tm.user_id');
    for (const m of members) await grantTeamRoles(c, { id: team.id, permissions: c.body.roleIds }, m.membership_id, m.user_id);
    return { status: 200, data: { teamId: team.id, roleIds: c.body.roleIds }, auditResourceId: team.id };
  },
});

defineRoute({
  method: 'put', path: '/teams/:id/department', module: M, moduleFlag: FLAG, summary: 'Link a team to a department',
  access: { permission: 'teams:update' }, params: idParams, body: z.object({ departmentId: uuid.nullable() }), response: obj,
  audit: { action: 'team.department_changed', resourceType: 'team' },
  async handler(c) {
    const team = await loadTeam(c, c.params.id);
    if (c.body.departmentId && !(await c.trx('departments').where({ id: c.body.departmentId, organization_id: c.orgId() }).whereNull('deleted_at').first())) {
      throw new AppError('VALIDATION_FAILED', 'Department not found', [{ field: 'departmentId', issue: 'not_found' }]);
    }
    await c.trx('teams').where({ id: team.id }).update({ department_id: c.body.departmentId, updated_at: c.svc.now() });
    return { status: 200, data: { teamId: team.id, departmentId: c.body.departmentId }, auditResourceId: team.id };
  },
});

defineRoute({
  method: 'get', path: '/teams/:id/history', module: M, moduleFlag: FLAG, summary: 'Append-only membership history',
  access: { permission: 'teams:read' }, params: idParams, query: listQuerySchema, response: obj,
  async handler(c) {
    await loadTeam(c, c.params.id);
    const page = await paginate(c.trx('team_membership_history').where({ organization_id: c.orgId(), team_id: c.params.id }), c.query as ListQuery,
      { sortable: { occurred_at: 'occurred_at' }, defaultSort: '-occurred_at' });
    return { data: page.data.map((r) => rowToApi(r)), meta: page.meta };
  },
});

defineRoute({
  method: 'get', path: '/teams/:id/activity', module: M, moduleFlag: FLAG, summary: 'Audited activity for a team',
  access: { permission: 'teams:read' }, params: idParams, query: listQuerySchema, response: obj,
  async handler(c) {
    await loadTeam(c, c.params.id);
    const page = await paginate(c.trx('audit_events').where({ organization_id: c.orgId(), resource_type: 'team', resource_id: c.params.id }), c.query as ListQuery,
      { sortable: { occurred_at: 'occurred_at' }, defaultSort: '-occurred_at' });
    return { data: page.data.map((r) => rowToApi(r)), meta: page.meta };
  },
});

defineRoute({
  method: 'get', path: '/teams/:id/capacity', module: M, moduleFlag: FLAG, summary: 'Open estimated work vs weekly capacity',
  access: { permission: 'teams:read' }, params: idParams, response: obj,
  async handler(c) {
    await loadTeam(c, c.params.id);
    const hoursPerDay = Number((await c.trx('organization_settings').where({ organization_id: c.orgId(), key: 'timesheets.work_hours_per_day' }).first())?.value ?? 8);
    const days = ((await c.trx('organization_settings').where({ organization_id: c.orgId(), key: 'timesheets.work_week' }).first())?.value as number[] | undefined)?.length ?? 5;
    const members = await c.trx('team_members as tm').join('users as u', 'u.id', 'tm.user_id').where('tm.team_id', c.params.id).select('u.id', 'u.name');
    const open = await c.trx('tasks').where({ organization_id: c.orgId() }).whereNull('deleted_at').whereNotIn('status', ['done', 'cancelled'])
      .whereIn('assignee_id', members.map((m) => m.id)).groupBy('assignee_id').select('assignee_id').sum({ hours: 'estimate_hours' });
    const byUser = new Map((open as unknown as { assignee_id: string; hours: string | null }[]).map((o) => [o.assignee_id, Number(o.hours ?? 0)]));
    const weekly = hoursPerDay * days;
    const rows = members.map((m) => ({ userId: m.id, name: m.name, openEstimateHours: byUser.get(m.id) ?? 0, weeklyCapacityHours: weekly,
      utilization: weekly ? Math.round(((byUser.get(m.id) ?? 0) / weekly) * 1000) / 10 : 0 }));
    return { data: { members: rows, totalOpenHours: rows.reduce((a, r) => a + r.openEstimateHours, 0), totalWeeklyCapacity: weekly * rows.length } };
  },
});
