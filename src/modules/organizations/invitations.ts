import { AppError } from '../../platform/errors.js';
import { newId, randomToken, sha256 } from '../../platform/crypto.js';
import type { HandlerCtx } from '../../platform/http/route.js';
import { assertCanGrant, getRole, rolePermissionKeys } from '../iam/service.js';
import { SYSTEM_ROLE_IDS } from '../iam/system-roles.js';

export const INVITATION_TTL_HOURS = 7 * 24;

/** Creates (or refreshes) a pending invitation and mails the single-use token. */
export async function inviteUser(c: HandlerCtx, email: string, roleId?: string) {
  const orgId = c.orgId();
  const effectiveRole = roleId ?? SYSTEM_ROLE_IDS.viewer; // least privilege default
  const role = await getRole(c.trx, orgId, effectiveRole);
  await assertCanGrant(c.trx, c.auth!, await rolePermissionKeys(c.trx, role.id));

  const existingUser = await c.trx.raw(
    `SELECT m.id FROM organization_memberships m JOIN users u ON u.id = m.user_id
      WHERE m.organization_id = ? AND u.email = ? AND m.status IN ('active','suspended')`, [orgId, email]);
  if (existingUser.rows.length > 0) throw new AppError('CONFLICT', 'This person is already a member');

  await c.trx('invitations').where({ organization_id: orgId, email, status: 'pending' }).update({ status: 'revoked', revoked_at: c.svc.now() });
  const token = randomToken();
  const id = newId();
  await c.trx('invitations').insert({
    id, organization_id: orgId, email, role_id: role.id, token_hash: sha256(token),
    expires_at: new Date(c.svc.now().getTime() + INVITATION_TTL_HOURS * 3600_000), invited_by: c.auth!.userId,
  });
  const org = await c.trx('organizations').where({ id: orgId }).first();
  await c.svc.mail.send({
    to: email, subject: `You have been invited to ${org.name}`,
    text: `${org.name} invited you to join. Your invitation token: ${token}`,
  });
  await c.emit('invitation.created', { invitationId: id });
  return { id, email, roleId: role.id, status: 'pending', expiresAt: new Date(c.svc.now().getTime() + INVITATION_TTL_HOURS * 3600_000).toISOString() };
}
