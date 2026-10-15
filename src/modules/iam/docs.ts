import { z } from 'zod';
import { documentRoutes, uuid, isoDate, messageResponse } from '../../platform/openapi/document.js';
import { rowOf } from '../../platform/openapi/rows.js';

const roleRef = z.object({
  id: uuid.describe('Role id.'), key: z.string().describe('Stable role key, e.g. `org_admin`.'),
  name: z.string().describe('Display name.'),
  scopeType: z.string().describe('Where the role applies: `organization`, or a narrower scope such as `team`.'),
  scopeId: uuid.nullable().describe('Scope resource id; `null` for organization scope.'),
});

const memberSummary = z.object({
  userId: uuid.describe('User id.'), membershipId: uuid.describe('Membership id in this organization.'),
  email: z.string().email().describe('Sign-in email.'), name: z.string().describe('Display name.'),
  status: z.enum(['active', 'suspended']).describe('Membership status in this organization.'),
  userStatus: z.string().describe('Global account status (`active`, `suspended`, ...).'),
  joinedAt: isoDate.nullable().describe('When the user joined the organization.'),
  roles: z.array(roleRef).describe('Roles currently granted to the member.'),
});

// Fixed depth (menu → sub-menu → item): the OpenAPI generator cannot express a recursive schema.
const menuFields = {
  key: z.string().describe('Stable menu key, e.g. `people.users`.'), title: z.string().describe('Display label.'),
  path: z.string().nullable().describe('Frontend route; `null` for a group that only holds sub-menus.'),
  icon: z.string().nullable().describe('Icon name hint; `null` when none.'),
};
const menuLeaf = z.object({ ...menuFields, children: z.array(z.string()).max(0).describe('Always empty at the third level.') });
const menuSub = z.object({ ...menuFields, children: z.array(menuLeaf).describe('Third-level items the caller may see.') });
const menuNode = z.object({ ...menuFields, children: z.array(menuSub).describe('Visible sub-menus (empty for a leaf).') });

const role = rowOf('roles').describe('A system role (`organizationId` is null) or an organization custom role.');
const permission = z.object({
  key: z.string().describe('Permission key `resource:action`, e.g. `projects:create`.'),
  resource: z.string().describe('Resource part of the key.'), action: z.string().describe('Action part of the key.'),
  description: z.string().describe('What the permission allows.'), module: z.string().describe('Module the permission belongs to.'),
});

documentRoutes({
  listUsers: {
    response: memberSummary, responseName: 'Member',
    list: { sortable: ['name', 'email', 'joined_at', 'created_at'], filterable: ['status'], defaultSort: 'name' },
    description: 'Lists the people who are members of the active organization (removed members are excluded), with their roles. `q` matches name or email.',
  },
  getUserById: { response: memberSummary, responseName: 'Member', description: 'Returns one member by **user** id. Users that are not (or no longer) members return `404`.' },
  createUser: {
    successStatus: 201,
    description: 'Invites a person by email (creates a pending invitation and sends the token mail). The person becomes a member after `acceptInvitation`. Counts against the plan\'s `max_members` entitlement.',
    response: z.object({
      id: uuid.describe('Invitation id.'), email: z.string().email().describe('Invited email address.'),
      roleId: uuid.describe('Role that will be granted on acceptance (the default member role when omitted).'),
      status: z.literal('pending').describe('Invitation status.'), expiresAt: isoDate.describe('The invitation token expires after 7 days.'),
    }),
  },
  updateUserStatus: {
    response: z.object({ userId: uuid.describe('Affected user.'), status: z.enum(['active', 'suspended']).describe('New membership status.') }),
    description: 'Suspends or reactivates a membership. Suspension revokes the member\'s sessions in this organization immediately. You cannot change your own status and the last Organization Admin cannot be suspended (`409`).',
  },
  deleteUser: { successStatus: 204, description: 'Removes the member from the organization (their account is kept). Revokes sessions and role assignments. You cannot remove yourself or the last Organization Admin (`409`).' },
  assignRoleToUser: {
    successStatus: [201, 202],
    response: z.object({
      userId: uuid.describe('The member.').optional(), roleId: uuid.describe('The granted role.').optional(),
      pendingApproval: z.boolean().describe('`true` when granting a privileged role needs a second approver (status `202`).').optional(),
      requestId: uuid.describe('Permission change request to approve (when `pendingApproval`).').optional(),
    }),
    errors: [409],
    description: 'Grants a role to a member. You can only grant roles whose permissions you hold yourself. Privileged roles may require approval: the response is then `202` with `pendingApproval: true` and a `requestId` for `approvePermissionChangeRequest`.',
  },
  unassignRoleFromUser: { successStatus: 204, errors: [409], description: 'Revokes a role from a member. The last Organization Admin assignment cannot be removed (`409`).' },
  listRoles: { response: role, responseName: 'Role', collection: true, description: 'Lists system roles and the organization\'s custom roles (system roles first).' },
  getRoleById: {
    response: role.extend({ permissions: z.array(z.string()).describe('Permission keys granted by the role, sorted.') }),
    responseName: 'RoleDetail', description: 'Returns a role together with its permission keys.',
  },
  createRole: {
    response: z.object({
      id: uuid.describe('New role id.'), key: z.string().describe('Role key.'), name: z.string().describe('Display name.'),
      description: z.string().describe('Description.'), permissions: z.array(z.string()).describe('Granted permission keys.'),
    }),
    errors: [409],
    description: 'Creates a custom role. You can only include permissions that you hold. `key` must be unique in the organization (`409`).',
  },
  updateRole: { response: role, responseName: 'Role', description: 'Renames or re-describes a custom role. System roles are immutable (`409`).' },
  deleteRole: { successStatus: 204, description: 'Deletes a custom role that is not assigned to anyone or any group (`409` otherwise).' },
  replaceRolePermissions: {
    response: z.object({ id: uuid.describe('Role id.'), permissions: z.array(z.string()).describe('The new permission keys, sorted.') }),
    successStatus: 200,
    description: 'Replaces the permission set of a custom role. Everyone holding the role gets the change on their next request (permission version bump). Unknown keys return `422`.',
  },
  listPermissions: { response: permission, responseName: 'Permission', collection: true, description: 'The permission catalog: every permission key the API knows, derived from the route definitions.' },
  addGroupMember: {
    successStatus: 201, response: z.object({ groupId: uuid.describe('Group.'), userId: uuid.describe('Added member.') }),
    description: 'Adds an active member to a group. Duplicates return `409`.',
  },
  removeGroupMember: { successStatus: 204, description: 'Removes a member from a group.' },
  replaceGroupRoles: {
    successStatus: 200, response: z.object({ id: uuid.describe('Group id.'), roleIds: z.array(uuid).describe('Roles now granted through the group.') }),
    description: 'Replaces the roles granted to every member of the group. You can only assign roles whose permissions you hold.',
  },
  createAccessRequest: {
    successStatus: 201, response: z.object({ id: uuid.describe('Request id.'), status: z.literal('pending').describe('Initial status.') }),
    description: 'Asks for a role. An approver decides with `approveAccessRequest` / `denyAccessRequest`.',
  },
  listAccessRequests: {
    response: rowOf('access_requests'), responseName: 'AccessRequest',
    list: { sortable: ['created_at', 'status'], filterable: ['status'], defaultSort: '-created_at', searchable: false },
    description: 'Lists access requests. Users with `access_requests:approve` see all; everyone else sees only their own.',
  },
  approveAccessRequest: {
    successStatus: 200, errors: [409], response: z.object({ id: uuid.describe('Request id.'), status: z.enum(['approved', 'denied']).describe('Decision.') }),
    description: 'Approves the request and grants the role. You cannot decide your own request (`403`) and a decided request returns `409`.',
  },
  denyAccessRequest: {
    successStatus: 200, errors: [409], response: z.object({ id: uuid.describe('Request id.'), status: z.enum(['approved', 'denied']).describe('Decision.') }),
    description: 'Denies the request with an optional note. You cannot decide your own request (`403`).',
  },
  getMyPermissions: {
    response: z.object({
      permissions: z.array(z.string()).describe('All permission keys of the caller, sorted.'),
      resources: z.record(z.string(), z.array(z.string())).describe('The same permissions grouped by resource: `{ "projects": ["read", "create"] }`.'),
      note: z.string().describe('Reminder that UI hiding is not enforcement.'),
    }),
    responseExample: { permissions: ['projects:create', 'projects:read'], resources: { projects: ['create', 'read'] }, note: 'UI hiding is never enforcement' },
    description: 'Returns what the signed-in user may do in the active organization. Use it to show or hide actions; the server enforces every permission regardless.',
  },
  getMyMenu: {
    response: z.object({
      menu: z.array(menuNode).describe('Top-level menu entries the caller may see, in display order. Groups carry their visible sub-menus in `children`.'),
      note: z.string().describe('Reminder that UI hiding is not enforcement.'),
    }),
    responseExample: {
      menu: [
        { key: 'dashboard', title: 'Dashboard', path: '/dashboard', icon: 'layout-dashboard', children: [] },
        { key: 'people', title: 'People & Access', path: null, icon: 'users', children: [
          { key: 'people.users', title: 'Users', path: '/users', icon: null, children: [] },
        ] },
      ],
      note: 'UI hiding is never enforcement',
    },
    description: 'Returns the navigation tree for the signed-in user in the active organization. Entries are filtered by the caller\'s permissions, the organization\'s module flags and platform-admin status; a group with no visible children is omitted. Render it as-is: menu content is owned by the backend.',
  },
  getPermissionMatrix: {
    response: z.object({
      permissions: z.array(z.string()).describe('All permission keys (columns).'),
      roles: z.array(z.object({
        id: uuid.describe('Role id.'), key: z.string().describe('Role key.'), name: z.string().describe('Role name.'),
        isSystem: z.boolean().describe('`true` for built-in roles.'), permissions: z.array(z.string()).describe('Permission keys of the role.'),
      })).describe('Roles (rows).'),
    }),
    description: 'Role × permission matrix for the admin console.',
  },
  getUserEffectiveAccess: {
    response: z.object({
      userId: uuid.describe('The member.'),
      directRoles: z.array(roleRef).describe('Roles assigned directly.'),
      groupRoles: z.array(z.object({ id: uuid.describe('Role id.'), key: z.string().describe('Role key.'), name: z.string().describe('Role name.'), groupName: z.string().describe('Group that grants it.') })).describe('Roles granted through groups.'),
      permissions: z.array(z.string()).describe('The union of organization-scope permissions, sorted.'),
    }),
    description: 'Explains why a member can do what they can: direct roles, group roles and the resulting permission set.',
  },
  listAccessHistory: {
    response: rowOf('access_history'), responseName: 'AccessHistoryEntry',
    list: { sortable: ['occurred_at'], filterable: [], defaultSort: '-occurred_at', searchable: false },
    description: 'Append-only history of role grants and revocations.',
  },
  createAccessReview: {
    successStatus: 201,
    response: z.object({ id: uuid.describe('Review id.'), items: z.number().int().describe('Number of role assignments to review.') }),
    description: 'Starts an access-review campaign containing every active organization-scope role assignment.',
  },
  getAccessReviewById: {
    response: rowOf('access_reviews').extend({ items: z.array(rowOf('access_review_items')).describe('Assignments under review.') }),
    responseName: 'AccessReview', description: 'Returns the review and its items. The review completes when no item is `pending`.',
  },
  decideAccessReviewItem: {
    successStatus: 200,
    response: z.object({ itemId: uuid.describe('Reviewed item.'), decision: z.enum(['keep', 'revoke']).describe('Decision taken.') }),
    description: '`revoke` removes the role assignment immediately; `keep` confirms it. A decided item returns `409`.',
  },
  listPermissionChangeRequests: {
    response: rowOf('permission_change_requests'), responseName: 'PermissionChangeRequest',
    list: { sortable: ['created_at'], filterable: ['status'], defaultSort: '-created_at', searchable: false },
    description: 'Privileged role grants waiting for a second approver.',
  },
  approvePermissionChangeRequest: {
    successStatus: 200, response: z.object({ id: uuid.describe('Request id.'), status: z.enum(['approved', 'applied', 'rejected']).describe('`applied` when the change was executed.') }),
    description: 'Approves and applies the privileged change. The requester cannot approve their own request (`403`).',
  },
  rejectPermissionChangeRequest: {
    successStatus: 200, response: z.object({ id: uuid.describe('Request id.'), status: z.enum(['approved', 'applied', 'rejected']).describe('`rejected`.') }),
    description: 'Rejects the privileged change. The requester cannot decide their own request (`403`).',
  },
});

void messageResponse;
