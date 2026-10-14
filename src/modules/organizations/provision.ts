import { randomBytes } from 'node:crypto';
import { newId } from '../../platform/crypto.js';
import { AppError } from '../../platform/errors.js';
import type { Trx } from '../../platform/scope.js';
import { SYSTEM_ROLE_IDS } from '../iam/system-roles.js';

export const RESERVED_CODES = new Set([
  'admin', 'api', 'www', 'app', 'support', 'help', 'root', 'system', 'nexus', 'platform', 'login', 'static', 'public',
  'status', 'billing', 'mail', 'null', 'undefined',
]);

export const CODE_FORMAT = /^[a-z0-9](?:[a-z0-9-]{1,38})[a-z0-9]$/;

export function slugify(input: string): string {
  const s = input.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36);
  return s.length >= 3 ? s : `org-${s || 'x'}`.slice(0, 36);
}

export function validateOrgCode(code: string): void {
  if (!CODE_FORMAT.test(code)) {
    throw new AppError('VALIDATION_FAILED', 'Invalid organization code', [
      { field: 'code', issue: 'use 3-40 lowercase letters, digits or hyphens' },
    ]);
  }
  if (RESERVED_CODES.has(code)) {
    throw new AppError('VALIDATION_FAILED', 'Organization code is reserved', [{ field: 'code', issue: 'reserved' }]);
  }
}

export interface ProvisionInput {
  name: string;
  code?: string;
  type: 'business' | 'personal';
  ownerUserId: string;
  timezone?: string;
  currency?: string;
}

/**
 * Shared provisioning path (self-service registration and platform provisioning):
 * organization + owner membership + Organization Admin role + storage usage row, all in one transaction.
 */
export async function provisionOrganization(trx: Trx, input: ProvisionInput): Promise<{ organizationId: string; membershipId: string; code: string }> {
  let code = input.code?.toLowerCase();
  if (code) {
    validateOrgCode(code);
    const taken = await trx('organizations').whereRaw('code = ? OR slug = ?', [code, code]).first();
    if (taken) throw new AppError('CONFLICT', 'Organization code is already taken', [{ field: 'code', issue: 'taken' }]);
  } else {
    const base = slugify(input.name);
    code = RESERVED_CODES.has(base) ? `${base}-org` : base;
    while (await trx('organizations').whereRaw('code = ? OR slug = ?', [code, code]).first()) {
      code = `${base.slice(0, 31)}-${randomBytes(3).toString('hex')}`;
    }
  }
  const organizationId = newId();
  await trx('organizations').insert({
    id: organizationId, name: input.name, code, slug: code, type: input.type, status: 'active',
    owner_user_id: input.ownerUserId, timezone: input.timezone ?? 'UTC', currency: input.currency ?? 'USD',
  });
  // Memberships/assignments are RLS-scoped to the new org: set the context for this transaction.
  await trx.raw(`SELECT set_config('app.current_org', ?, true)`, [organizationId]);
  const membershipId = newId();
  await trx('organization_memberships').insert({
    id: membershipId, organization_id: organizationId, user_id: input.ownerUserId, status: 'active',
    joined_at: new Date(), created_by: input.ownerUserId,
  });
  await trx('user_role_assignments').insert({
    id: newId(), organization_id: organizationId, membership_id: membershipId,
    role_id: SYSTEM_ROLE_IDS.org_admin, scope_type: 'organization', created_by: input.ownerUserId,
  });
  await trx('storage_usage').insert({ organization_id: organizationId, bytes_used: 0 });
  await trx('access_history').insert({
    id: newId(), organization_id: organizationId, actor_id: input.ownerUserId, subject_user_id: input.ownerUserId,
    role_id: SYSTEM_ROLE_IDS.org_admin, change: 'granted', reason: 'organization created',
  });
  return { organizationId, membershipId, code };
}
