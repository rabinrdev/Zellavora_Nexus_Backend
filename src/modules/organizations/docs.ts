import { z } from 'zod';
import { documentRoutes, uuid, isoDate } from '../../platform/openapi/document.js';
import { rowOf } from '../../platform/openapi/rows.js';

const organization = rowOf('organizations', {
  only: ['id', 'name', 'code', 'slug', 'type', 'status', 'timezone', 'locale', 'currency', 'owner_user_id', 'logo_file_id', 'branding', 'row_version', 'created_at', 'updated_at'],
  describe: {
    code: 'Unique organization code used at sign-in.', slug: 'URL slug used by the public site.', type: '`individual` or `business`.',
    status: 'Lifecycle status: `pending`, `active`, `suspended` or `closed`.', ownerUserId: 'User id of the owner.',
    logoFileId: 'Uploaded image used as the logo.', branding: 'Brand colors and tagline: `{ primaryColor, accentColor, tagline }`.',
  },
  extend: {
    branding: z.object({
      primaryColor: z.string().optional().describe('Hex color, e.g. `#4f46e5`.'),
      accentColor: z.string().optional().describe('Hex color.'),
      tagline: z.string().optional().describe('Short tagline (max 160 characters).'),
    }).nullable().describe('Brand colors and tagline.'),
  },
});

const orgRef = z.object({
  id: uuid.describe('Organization id.'), name: z.string().describe('Organization name.'), code: z.string().describe('Organization code.'),
  type: z.string().describe('`individual` or `business`.'), status: z.string().describe('Lifecycle status.'),
  active: z.boolean().describe('`true` for the organization of the current session.'),
});

const decision = z.object({ id: uuid.describe('Resource id.'), status: z.string().describe('New status.') });

documentRoutes({
  getCurrentOrganization: { response: organization, responseName: 'Organization', description: 'Profile and branding of the active organization. Readable even while the organization is suspended.' },
  updateCurrentOrganization: {
    response: organization, responseName: 'Organization', errors: [412],
    description: 'Updates the name, logo and branding. Send `rowVersion` from the last read to detect concurrent edits (`412`). The logo must be an uploaded image of this organization.',
  },
  updateOrganizationDefaults: { response: organization, responseName: 'Organization', description: 'Sets the default time zone (IANA), locale (`en-GB`) and currency (ISO-4217) used for new data.' },
  checkOrganizationCodeAvailability: {
    successStatus: 200,
    response: z.object({
      available: z.boolean().describe('`true` when the code can be used.'),
      reason: z.enum(['invalid_format', 'reserved', 'taken']).optional().describe('Why the code is not available.'),
    }),
    description: 'Public helper for the sign-up form. Rate limited (`search` bucket).',
  },
  listMyOrganizations: { response: orgRef, responseName: 'MyOrganization', collection: true, description: 'Organizations the signed-in user is an active member of. Use `switchOrganization` to change the active one.' },
  suspendOrganization: {
    successStatus: 200, response: decision, errors: [409],
    description: 'Platform administrators only. Suspended organizations return `TENANT_SUSPENDED` to their members. Invalid transitions return `409`.',
  },
  reactivateOrganization: { successStatus: 200, response: decision, errors: [409], description: 'Platform administrators only. Reactivates a suspended organization.' },
  createInvitation: {
    successStatus: 201,
    response: z.object({
      id: uuid.describe('Invitation id.'), email: z.string().email().describe('Invited address.'), roleId: uuid.describe('Role granted on acceptance.'),
      status: z.literal('pending').describe('Initial status.'), expiresAt: isoDate.describe('Expiry (7 days).'),
    }),
    description: 'Invites a person by email. Counts against the plan\'s `max_members` entitlement (`402` when exceeded).',
  },
  listInvitations: {
    response: z.object({
      id: uuid.describe('Invitation id.'), email: z.string().describe('Invited address.'), roleId: uuid.nullable().describe('Role granted on acceptance.'),
      status: z.string().describe('`pending`, `accepted`, `revoked` or `expired`.'), expiresAt: isoDate.describe('Expiry.'),
      invitedBy: uuid.nullable().describe('Inviter.'), createdAt: isoDate.describe('Created.'),
      acceptedAt: isoDate.nullable().describe('Accepted at.'), revokedAt: isoDate.nullable().describe('Revoked at.'),
    }),
    responseName: 'Invitation', list: { sortable: ['created_at', 'email'], filterable: ['status'], defaultSort: '-created_at', searchable: false },
    description: 'Lists invitations of the organization (tokens are never returned).',
  },
  revokeInvitation: { successStatus: 200, response: decision, description: 'Revokes a pending invitation. Already used or revoked invitations return `404`.' },
  resendInvitation: { successStatus: 200, response: decision, description: 'Issues a fresh token and extends the expiry; the old token stops working.' },
  startOwnershipTransfer: {
    successStatus: 201, response: z.object({ id: uuid.describe('Transfer id.'), status: z.literal('pending').describe('Initial status.') }),
    description: 'Only the current owner can start a transfer and must re-enter their password. The recipient must be an active member and has 7 days to call `acceptOwnershipTransfer`. Any older pending transfer is cancelled.',
  },
  acceptOwnershipTransfer: {
    successStatus: 200,
    response: z.object({ organizationId: uuid.describe('Organization.'), ownerUserId: uuid.describe('The new owner (the caller).') }),
    description: 'Only the recipient can accept. Ownership moves and the new owner gets the Organization Admin role.',
  },
  cancelOwnershipTransfer: { successStatus: 200, response: decision, description: 'Cancels a pending transfer (owner side).' },
});
