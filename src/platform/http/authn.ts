import type { Request } from 'express';
import { AppError } from '../errors.js';
import type { AuthContext, Services } from '../types.js';
import { verifyAccessToken } from '../auth/tokens.js';
import { withPlatformScope, withTenant, withUser } from '../scope.js';
import { cachedOrgPermissions } from '../authz.js';
import { sha256 } from '../crypto.js';

const UNAUTH = () => new AppError('UNAUTHENTICATED', 'Authentication required');

export interface AuthnOptions {
  allowSuspendedTenant?: boolean;
  allowPendingMfa?: boolean;
}

/**
 * Single entry point for protected routes (F-008). Validates the token, then re-checks server-side state on
 * every request: session not revoked/expired, user active, permission version current, tenant active,
 * membership active. Role claims in the token are never trusted (there are none).
 */
export async function authenticate(svc: Services, req: Request, opts: AuthnOptions = {}): Promise<AuthContext> {
  const header = req.get('authorization');
  if (!header?.startsWith('Bearer ')) throw UNAUTH();
  const token = header.slice(7).trim();
  if (token.startsWith('nxk_')) return authenticateApiKey(svc, token, opts);

  const claims = await verifyAccessToken(svc.env.JWT_SECRET, token);
  if (!claims) throw UNAUTH();

  const now = svc.now();
  const session = await svc.db('sessions').where({ id: claims.sid, user_id: claims.sub }).first();
  if (!session || session.revoked_at) throw UNAUTH();
  if (session.pending_mfa && !opts.allowPendingMfa) throw UNAUTH();
  if (new Date(session.idle_expires_at) < now || new Date(session.absolute_expires_at) < now) throw UNAUTH();

  const user = await svc.db('users').where({ id: claims.sub }).first();
  if (!user || user.status !== 'active') throw UNAUTH();
  if (user.permission_version !== claims.pv) throw UNAUTH(); // revocation / role change takes effect immediately

  // slide idle expiry (throttled to one write per minute)
  const sinceSeen = now.getTime() - new Date(session.last_seen_at).getTime();
  if (sinceSeen > 60_000) {
    const idleMs = new Date(session.idle_expires_at).getTime() - new Date(session.last_seen_at).getTime();
    const newIdle = Math.min(now.getTime() + idleMs, new Date(session.absolute_expires_at).getTime());
    await svc.db('sessions').where({ id: session.id }).update({ last_seen_at: now, idle_expires_at: new Date(newIdle) });
  }

  const orgId: string | null = session.active_organization_id ?? null;
  if (!orgId || claims.org !== orgId) {
    return {
      userId: user.id, sessionId: session.id, organizationId: null, membershipId: null,
      permissions: new Set(), isPlatformAdmin: user.is_platform_admin, permissionVersion: user.permission_version, realm: 'staff',
    };
  }

  const org = await svc.db('organizations').where({ id: orgId }).first();
  if (!org) throw UNAUTH();
  if (session.realm === 'support') {
    // platform support: needs a tenant-granted, unexpired, unrevoked grant; read-only permission set
    const grant = user.is_platform_admin && await withPlatformScope(svc.db, 'support-grant', (t) =>
      t('support_access_grants').where({ organization_id: orgId }).whereNull('revoked_at').where('expires_at', '>', now).first());
    if (!grant) throw UNAUTH();
    const reads = await svc.db('permissions').where({ action: 'read' }).select('key');
    return {
      userId: user.id, sessionId: session.id, organizationId: orgId, membershipId: null,
      permissions: new Set(reads.map((r) => r.key as string)), isPlatformAdmin: false, permissionVersion: user.permission_version, realm: 'support',
    };
  }
  if (org.status !== 'active' && !user.is_platform_admin && !opts.allowSuspendedTenant) {
    throw new AppError('TENANT_SUSPENDED', 'This organization is not active');
  }

  const { membership, perms } = await withTenant(svc.db, { organizationId: orgId, userId: user.id }, async (trx) => {
    const m = await trx('organization_memberships').where({ organization_id: orgId, user_id: user.id, status: 'active' }).first();
    if (!m) return { membership: null, perms: new Set<string>() };
    return { membership: m, perms: await cachedOrgPermissions(trx, m.id, user.permission_version) };
  });
  if (!membership) throw UNAUTH();

  return {
    userId: user.id, sessionId: session.id, organizationId: orgId, membershipId: membership.id,
    permissions: perms, isPlatformAdmin: user.is_platform_admin, permissionVersion: user.permission_version, realm: 'staff',
  };
}

async function authenticateApiKey(svc: Services, token: string, opts: AuthnOptions): Promise<AuthContext> {
  const row = await withPlatformScope(svc.db, 'api-key-auth', (t) =>
    t('api_keys').where({ key_hash: sha256(token) }).first(),
  );
  const now = svc.now();
  if (!row || row.revoked_at || (row.expires_at && new Date(row.expires_at) < now)) throw UNAUTH();
  const org = await svc.db('organizations').where({ id: row.organization_id }).first();
  if (!org || (org.status !== 'active' && !opts.allowSuspendedTenant)) {
    throw new AppError('TENANT_SUSPENDED', 'This organization is not active');
  }
  await withPlatformScope(svc.db, 'api-key-touch', (t) => t('api_keys').where({ id: row.id }).update({ last_used_at: now }));
  void withUser;
  return {
    userId: row.created_by, sessionId: row.id, organizationId: row.organization_id, membershipId: null,
    permissions: new Set<string>(row.scopes), isPlatformAdmin: false, permissionVersion: 0, realm: 'apikey', apiKeyId: row.id,
  };
}
