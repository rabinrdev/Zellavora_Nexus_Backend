import { z } from 'zod';
import { documentRoutes, uuid, isoDate } from '../../platform/openapi/document.js';
import { rowOf } from '../../platform/openapi/rows.js';

const teamMember = z.object({
  userId: uuid.describe('Member user id.'), name: z.string().describe('Display name.'), email: z.string().email().describe('Email.'),
  isLeader: z.boolean().describe('`true` for team leaders.'), joinedAt: isoDate.describe('When the member joined the team.'),
});
const membership = z.object({ teamId: uuid.describe('Team id.'), userId: uuid.describe('Member user id.') });

documentRoutes({
  listTeamMembers: { response: teamMember, responseName: 'TeamMember', collection: true, description: 'Members of the team ordered by name.' },
  addTeamMember: {
    successStatus: 201, response: membership, errors: [409],
    description: 'Adds an active organization member to the team. Roles configured via `replaceTeamPermissions` are granted with team scope. Adding the same user twice returns `409`.',
  },
  removeTeamMember: { successStatus: 204, description: 'Removes the member and their team-scoped role assignments.' },
  replaceTeamLeaders: {
    successStatus: 200, response: z.object({ teamId: uuid.describe('Team id.'), leaders: z.array(uuid).describe('Leader user ids.') }),
    description: 'Replaces the set of leaders. Every leader must already be a team member (`422`).',
  },
  replaceTeamPermissions: {
    successStatus: 200, response: z.object({ teamId: uuid.describe('Team id.'), roleIds: z.array(uuid).describe('Roles granted to members with team scope.') }),
    description: 'Sets the roles every team member receives **within this team** (scope `team`). You may only grant roles whose permissions you hold (`403`).',
  },
  setTeamDepartment: {
    successStatus: 200, response: z.object({ teamId: uuid.describe('Team id.'), departmentId: uuid.nullable().describe('Linked department; `null` unlinks.') }),
    description: 'Links the team to a department, or unlinks it with `null`.',
  },
  listTeamHistory: {
    response: rowOf('team_membership_history'), responseName: 'TeamMembershipChange',
    list: { sortable: ['occurred_at'], filterable: [], defaultSort: '-occurred_at', searchable: false },
    description: 'Append-only history of member additions, removals and leader changes.',
  },
  listTeamActivity: {
    response: rowOf('audit_events'), responseName: 'AuditEvent',
    list: { sortable: ['occurred_at'], filterable: [], defaultSort: '-occurred_at', searchable: false },
    description: 'Audit events whose resource is this team.',
  },
  getTeamCapacity: {
    response: z.object({
      members: z.array(z.object({
        userId: uuid.describe('Member.'), name: z.string().describe('Name.'), openEstimateHours: z.number().describe('Estimated hours of open tasks assigned.'),
        weeklyCapacityHours: z.number().describe('Working hours per week from organization settings.'), utilization: z.number().describe('Open hours as % of weekly capacity (1 decimal).'),
      })).describe('Per-member workload.'),
      totalOpenHours: z.number().describe('Sum of open estimated hours.'), totalWeeklyCapacity: z.number().describe('Combined weekly capacity in hours.'),
    }),
    responseName: 'TeamCapacity', description: 'Open estimated work compared with weekly capacity (`timesheets.work_hours_per_day` × `timesheets.work_week`).',
  },
});
