import { randomInt } from 'node:crypto';
import type { Knex } from 'knex';
import { AppError } from '../../platform/errors.js';
import { newId, randomToken, sha256, encrypt, decrypt } from '../../platform/crypto.js';
import { hashPassword, verifyPassword, dummyVerify, passwordProblems } from '../../platform/auth/password.js';
import { signAccessToken, ACCESS_TTL_SECONDS } from '../../platform/auth/tokens.js';
import { loadSecurityPolicy, type SecurityPolicy } from '../../platform/security-policy.js';
import { withPlatformScope, type Trx } from '../../platform/scope.js';
import { recordSecurityEvent, recordAudit, type RequestMeta } from '../../platform/audit.js';
import { newTotpSecret, totpUri, verifyTotp } from '../../platform/auth/totp.js';
import { provisionOrganization } from '../organizations/provision.js';
import { SYSTEM_ROLE_IDS } from '../iam/system-roles.js';
import type { Services } from '../../platform/types.js';

const GENERIC_LOGIN_ERROR = 'Invalid credentials';
const unauth = (msg = GENERIC_LOGIN_ERROR, details: { field?: string; issue: string }[] = []) =>
  new AppError('UNAUTHENTICATED', msg, details);

export interface ReqMeta {
  ip: string | null;
  userAgent: string | null;
  requestId: string;
}
const rm = (m: ReqMeta, organizationId: string | null = null, userId: string | null = null): RequestMeta & { userId: string | null } => ({
  organizationId, actorId: userId, userId, correlationId: m.requestId, ip: m.ip, userAgent: m.userAgent,
});

const hoursFromNow = (now: Date, h: number) => new Date(now.getTime() + h * 3600_000);

async function enforcePasswordPolicy(
  db: Knex | Trx,
  pw: string,
  policy: SecurityPolicy,
  ctx: { email?: string; userId?: string },
) {
  const issues = passwordProblems(pw, policy.password, ctx).map((i) => ({ field: 'password', issue: i }));
  if (ctx.userId) {
    const hist = await db('password_history').where({ user_id: ctx.userId }).orderBy('created_at', 'desc').limit(policy.password.historyDepth);
    for (const h of hist) {
      if (await verifyPassword(h.password_hash, pw)) {
        issues.push({ field: 'password', issue: 'was used recently; choose a new password' });
        break;
      }
    }
  }
  if (issues.length) throw new AppError('VALIDATION_FAILED', 'Password does not meet the policy', issues);
}

async function issueVerification(svc: Services, trx: Trx, userId: string, email: string, purpose: 'email_verify' | 'password_reset') {
  const token = randomToken();
  await trx('verification_tokens').insert({
    id: newId(), user_id: userId, purpose, token_hash: sha256(token),
    expires_at: hoursFromNow(svc.now(), purpose === 'email_verify' ? 48 : 1),
  });
  const subject = purpose === 'email_verify' ? 'Verify your email' : 'Reset your password';
  await svc.mail.send({ to: email, subject, text: `Your ${purpose === 'email_verify' ? 'verification' : 'reset'} token: ${token}` });
}

export interface RegisterInput {
  kind: 'individual' | 'organization';
  name: string;
  email: string;
  password: string;
  organizationName?: string;
  organizationCode?: string;
}

/** Always resolves identically so the endpoint cannot be used to enumerate accounts. */
export async function register(svc: Services, input: RegisterInput, m: ReqMeta): Promise<void> {
  const email = input.email.toLowerCase();
  const policy = await loadSecurityPolicy(svc.db, null);
  await enforcePasswordPolicy(svc.db, input.password, policy, { email });
  const hash = await hashPassword(input.password);
  await withPlatformScope(svc.db, 'register', async (trx) => {
    const existing = await trx('users').where({ email }).first();
    if (existing) {
      await recordSecurityEvent(trx, rm(m, null, existing.id), 'register_existing_email', 'failure');
      await svc.mail.send({ to: email, subject: 'Sign-up attempt', text: 'Someone tried to register with this email. If this was you, sign in or reset your password.' });
      return;
    }
    const userId = newId();
    await trx('users').insert({ id: userId, email, name: input.name, password_hash: hash, password_changed_at: svc.now() });
    await trx('password_history').insert({ id: newId(), user_id: userId, password_hash: hash });
    const orgName = input.kind === 'organization' ? (input.organizationName ?? `${input.name}'s organization`) : `${input.name}'s workspace`;
    await provisionOrganization(trx, {
      name: orgName, code: input.kind === 'organization' ? input.organizationCode : undefined,
      type: input.kind === 'organization' ? 'business' : 'personal', ownerUserId: userId,
    });
    await issueVerification(svc, trx, userId, email, 'email_verify');
    await recordSecurityEvent(trx, rm(m, null, userId), 'register');
  });
}

export async function verifyEmail(svc: Services, token: string, m: ReqMeta): Promise<void> {
  await withPlatformScope(svc.db, 'verify-email', async (trx) => {
    const row = await trx('verification_tokens')
      .where({ token_hash: sha256(token), purpose: 'email_verify' }).whereNull('used_at').where('expires_at', '>', svc.now()).first();
    if (!row) throw new AppError('VALIDATION_FAILED', 'Invalid or expired token', [{ field: 'token', issue: 'invalid' }]);
    await trx('verification_tokens').where({ id: row.id }).update({ used_at: svc.now() });
    await trx('users').where({ id: row.user_id }).update({ email_verified_at: svc.now(), updated_at: svc.now() });
    await recordSecurityEvent(trx, rm(m, null, row.user_id), 'email_verified');
  });
}

export async function resendVerification(svc: Services, email: string): Promise<void> {
  await withPlatformScope(svc.db, 'resend-verification', async (trx) => {
    const u = await trx('users').where({ email: email.toLowerCase() }).whereNull('email_verified_at').first();
    if (u) await issueVerification(svc, trx, u.id, u.email, 'email_verify');
  });
}

export async function forgotPassword(svc: Services, email: string, m: ReqMeta): Promise<void> {
  await withPlatformScope(svc.db, 'forgot-password', async (trx) => {
    const u = await trx('users').where({ email: email.toLowerCase(), status: 'active' }).first();
    if (!u) return;
    await issueVerification(svc, trx, u.id, u.email, 'password_reset');
    await recordSecurityEvent(trx, rm(m, null, u.id), 'password_reset_requested');
  });
}

export async function revokeAllSessions(trx: Trx, userId: string, reason: string, now: Date, exceptSessionId?: string) {
  const q = trx('sessions').where({ user_id: userId }).whereNull('revoked_at');
  if (exceptSessionId) q.whereNot({ id: exceptSessionId });
  await q.update({ revoked_at: now, revoked_reason: reason });
}

export async function resetPassword(svc: Services, token: string, newPassword: string, m: ReqMeta): Promise<void> {
  const policy = await loadSecurityPolicy(svc.db, null);
  await withPlatformScope(svc.db, 'reset-password', async (trx) => {
    const row = await trx('verification_tokens')
      .where({ token_hash: sha256(token), purpose: 'password_reset' }).whereNull('used_at').where('expires_at', '>', svc.now()).first();
    if (!row) throw new AppError('VALIDATION_FAILED', 'Invalid or expired token', [{ field: 'token', issue: 'invalid' }]);
    const user = await trx('users').where({ id: row.user_id }).first();
    await enforcePasswordPolicy(trx, newPassword, policy, { email: user.email, userId: user.id });
    const hash = await hashPassword(newPassword);
    await trx('verification_tokens').where({ id: row.id }).update({ used_at: svc.now() });
    await trx('users').where({ id: user.id }).update({
      password_hash: hash, password_changed_at: svc.now(), failed_login_count: 0, locked_until: null,
      permission_version: trx.raw('permission_version + 1'), updated_at: svc.now(),
    });
    await trx('password_history').insert({ id: newId(), user_id: user.id, password_hash: hash });
    await revokeAllSessions(trx, user.id, 'password_reset', svc.now());
    await recordSecurityEvent(trx, rm(m, null, user.id), 'password_reset_completed');
  });
}

/** Whether a password-reset token is still usable (lets the UI show the form or an "expired" page before submit). */
export async function validateResetToken(svc: Services, token: string): Promise<boolean> {
  return withPlatformScope(svc.db, 'reset-token-validate', async (trx) => {
    const row = await trx('verification_tokens')
      .where({ token_hash: sha256(token), purpose: 'password_reset' }).whereNull('used_at').where('expires_at', '>', svc.now()).first();
    return !!row;
  });
}

/** Re-authenticates with the current password; other sessions are revoked, the caller's stays signed in. */
export async function changePassword(
  svc: Services, userId: string, sessionId: string, currentPassword: string, newPassword: string, m: ReqMeta,
): Promise<{ revokedSessions: number }> {
  const policy = await loadSecurityPolicy(svc.db, null);
  return withPlatformScope(svc.db, 'change-password', async (trx) => {
    const user = await trx('users').where({ id: userId, status: 'active' }).first();
    if (!user || !user.password_hash) throw unauth();
    if (!(await verifyPassword(user.password_hash, currentPassword))) {
      await recordSecurityEvent(trx, rm(m, null, userId), 'password_change_failed', 'failure');
      throw new AppError('VALIDATION_FAILED', 'Current password is incorrect', [{ field: 'currentPassword', issue: 'incorrect' }]);
    }
    if (currentPassword === newPassword) {
      throw new AppError('VALIDATION_FAILED', 'Password does not meet the policy', [{ field: 'newPassword', issue: 'must differ from the current password' }]);
    }
    await enforcePasswordPolicy(trx, newPassword, policy, { email: user.email, userId });
    const hash = await hashPassword(newPassword);
    await trx('users').where({ id: userId }).update({
      password_hash: hash, password_changed_at: svc.now(), updated_at: svc.now(),
    });
    await trx('password_history').insert({ id: newId(), user_id: userId, password_hash: hash });
    const revoked = await trx('sessions').where({ user_id: userId }).whereNull('revoked_at').whereNot({ id: sessionId })
      .update({ revoked_at: svc.now(), revoked_reason: 'password_changed' });
    await recordSecurityEvent(trx, rm(m, null, userId), 'password_changed', 'success', { revokedSessions: revoked });
    await svc.mail.send({ to: user.email, subject: 'Your password was changed', text: 'Your password was just changed. If this was not you, reset your password immediately.' });
    return { revokedSessions: revoked };
  });
}

export interface LoginInput { email: string; password: string; organizationCode?: string; mfaCode?: string }

export interface TokenBundle {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  sessionId: string;
  organizationId: string | null;
  mfaSetupRequired: boolean;
}

async function createSession(
  svc: Services, trx: Trx, user: { id: string; permission_version: number },
  organizationId: string | null, policy: SecurityPolicy, m: ReqMeta, flags: { pendingMfa: boolean; mfaVerified: boolean },
): Promise<TokenBundle> {
  const now = svc.now();
  const sessionId = newId();
  const refresh = randomToken(48);
  await trx('sessions').insert({
    id: sessionId, user_id: user.id, active_organization_id: organizationId, refresh_token_hash: sha256(refresh),
    family_id: sessionId, ip: m.ip, user_agent: m.userAgent?.slice(0, 300) ?? null,
    idle_expires_at: new Date(now.getTime() + policy.session.idleMinutes * 60_000),
    absolute_expires_at: new Date(now.getTime() + policy.session.absoluteMinutes * 60_000),
    pending_mfa: flags.pendingMfa, mfa_verified: flags.mfaVerified,
  });
  const accessToken = await signAccessToken(svc.env.JWT_SECRET, {
    sub: user.id, sid: sessionId, org: organizationId, pv: user.permission_version,
  });
  return { accessToken, refreshToken: refresh, expiresIn: ACCESS_TTL_SECONDS, sessionId, organizationId, mfaSetupRequired: flags.pendingMfa };
}

async function consumeRecoveryCode(trx: Trx, userId: string, code: string): Promise<boolean> {
  const row = await trx('mfa_recovery_codes').where({ user_id: userId, code_hash: sha256(code.trim().toLowerCase()) }).whereNull('used_at').first();
  if (!row) return false;
  await trx('mfa_recovery_codes').where({ id: row.id }).update({ used_at: new Date() });
  return true;
}

// ---- email one-time codes (second factor) -------------------------------------------------------------------

const EMAIL_OTP_TTL_MINUTES = 10;
const EMAIL_OTP_RESEND_SECONDS = 60;
type OtpPurpose = 'mfa_email_login' | 'mfa_email_enrol';
const otpHash = (userId: string, purpose: OtpPurpose, code: string) => sha256(`${userId}:${purpose}:${code.trim()}`);

/** Mails a fresh 6-digit code and invalidates earlier ones. Skips the send when one went out in the last minute. */
async function sendEmailOtp(svc: Services, trx: Trx, user: { id: string; email: string }, purpose: OtpPurpose): Promise<void> {
  const now = svc.now();
  const recent = await trx('verification_tokens').where({ user_id: user.id, purpose }).whereNull('used_at')
    .where('expires_at', '>', now).where('created_at', '>', new Date(now.getTime() - EMAIL_OTP_RESEND_SECONDS * 1000)).first();
  if (recent) return;
  await trx('verification_tokens').where({ user_id: user.id, purpose }).whereNull('used_at').update({ used_at: now });
  const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
  await trx('verification_tokens').insert({
    id: newId(), user_id: user.id, purpose, token_hash: otpHash(user.id, purpose, code),
    expires_at: new Date(now.getTime() + EMAIL_OTP_TTL_MINUTES * 60_000),
  });
  await svc.mail.send({
    to: user.email,
    subject: purpose === 'mfa_email_enrol' ? 'Your two-factor setup code' : 'Your sign-in code',
    text: `Your verification code is ${code}. It expires in ${EMAIL_OTP_TTL_MINUTES} minutes. If you did not request it, change your password.`,
  });
}

async function consumeEmailOtp(svc: Services, trx: Trx, userId: string, purpose: OtpPurpose, code: string): Promise<boolean> {
  if (!/^\d{6}$/.test(code.trim())) return false;
  const row = await trx('verification_tokens')
    .where({ token_hash: otpHash(userId, purpose, code), purpose }).whereNull('used_at').where('expires_at', '>', svc.now()).first();
  if (!row) return false;
  await trx('verification_tokens').where({ id: row.id }).update({ used_at: svc.now() });
  return true;
}

/** TOTP or emailed code (recovery codes are checked by the callers that accept them). */
async function checkSecondFactor(svc: Services, trx: Trx, userId: string, code: string): Promise<boolean> {
  const factors: { type: string; secret_encrypted: string }[] = await trx('mfa_factors').where({ user_id: userId }).whereNotNull('confirmed_at');
  const totp = factors.find((f) => f.type === 'totp');
  if (totp && /^\d{6}$/.test(code.trim()) && verifyTotp(decrypt(svc.keys, totp.secret_encrypted), code)) return true;
  if (factors.some((f) => f.type === 'email_otp')) return consumeEmailOtp(svc, trx, userId, 'mfa_email_login', code);
  return false;
}

/** Counts a failed attempt (password or second factor) and locks the account with exponential back-off past the threshold. */
async function countFailure(
  trx: Trx, user: { id: string; failed_login_count: number }, policy: SecurityPolicy, now: Date, m: ReqMeta, organizationId: string | null = null,
): Promise<void> {
  const count = user.failed_login_count + 1;
  const patch: Record<string, unknown> = { failed_login_count: count };
  if (count >= policy.lockout.threshold) {
    const minutes = Math.min(policy.lockout.maxMinutes, policy.lockout.baseMinutes * 2 ** (count - policy.lockout.threshold));
    patch.locked_until = new Date(now.getTime() + minutes * 60_000);
    await recordSecurityEvent(trx, rm(m, organizationId, user.id), 'account_locked', 'denied', { minutes });
  }
  await trx('users').where({ id: user.id }).update(patch);
}

export async function login(svc: Services, input: LoginInput, m: ReqMeta): Promise<TokenBundle & { organizations: { id: string; name: string; code: string }[] }> {
  const email = input.email.toLowerCase();
  const now = svc.now();
  const result = await withPlatformScope(svc.db, 'login', async (trx) => {
    const user = await trx('users').where({ email }).first();
    if (!user || !user.password_hash) {
      await dummyVerify(input.password);
      await recordSecurityEvent(trx, rm(m), 'login_failed', 'failure', { reason: 'unknown_account' });
      return { failure: unauth() };
    }
    const policy = await loadSecurityPolicy(svc.db, null);
    if (user.locked_until && new Date(user.locked_until) > now) {
      await dummyVerify(input.password);
      await recordSecurityEvent(trx, rm(m, null, user.id), 'login_blocked_locked', 'denied');
      return { failure: unauth() };
    }
    const ok = await verifyPassword(user.password_hash, input.password);
    if (!ok) {
      await countFailure(trx, user, policy, now, m);
      await recordSecurityEvent(trx, rm(m, null, user.id), 'login_failed', 'failure', { reason: 'bad_password' });
      return { failure: unauth() };
    }
    if (user.status !== 'active' || !user.email_verified_at) {
      await recordSecurityEvent(trx, rm(m, null, user.id), 'login_failed', 'failure', { reason: 'not_active_or_unverified' });
      return { failure: unauth() };
    }

    // organization resolution (F-002): by code, else single/most-recent membership
    const memberships: { id: string; name: string; code: string; status: string }[] = (
      await trx.raw(
        `SELECT o.id, o.name, o.code::text AS code, o.status
           FROM organization_memberships m JOIN organizations o ON o.id = m.organization_id
          WHERE m.user_id = ? AND m.status = 'active'
          ORDER BY o.created_at`, [user.id])
    ).rows;
    let organizationId: string | null = null;
    if (input.organizationCode) {
      const hit = memberships.find((o) => o.code.toLowerCase() === input.organizationCode!.toLowerCase());
      if (!hit || (hit.status !== 'active' && !user.is_platform_admin)) {
        await recordSecurityEvent(trx, rm(m, null, user.id), 'login_failed', 'failure', { reason: 'org_not_available' });
        return { failure: unauth() };
      }
      organizationId = hit.id;
    } else {
      const last = await trx('sessions').where({ user_id: user.id }).whereNotNull('active_organization_id').orderBy('created_at', 'desc').first();
      const active = memberships.filter((o) => o.status === 'active');
      organizationId = (active.find((o) => o.id === last?.active_organization_id) ?? active[0])?.id ?? null;
    }

    // MFA
    const factors: { type: string }[] = await trx('mfa_factors').where({ user_id: user.id }).whereNotNull('confirmed_at');
    const factor = factors[0];
    const orgPolicy = await loadSecurityPolicy(svc.db, organizationId);
    let mfaVerified = false;
    if (factor) {
      const usesEmail = !factors.some((f) => f.type === 'totp');
      if (!input.mfaCode) {
        if (usesEmail) await sendEmailOtp(svc, trx, user, 'mfa_email_login');
        return {
          failure: unauth('MFA code required', [
            { field: 'mfaCode', issue: 'mfa_required' },
            { field: 'mfaMethod', issue: usesEmail ? 'email_otp' : 'totp' },
          ]),
        };
      }
      mfaVerified = (await checkSecondFactor(svc, trx, user.id, input.mfaCode)) || (await consumeRecoveryCode(trx, user.id, input.mfaCode));
      if (!mfaVerified) {
        await countFailure(trx, user, policy, now, m, organizationId);
        await recordSecurityEvent(trx, rm(m, organizationId, user.id), 'mfa_failed', 'failure');
        return { failure: unauth() };
      }
    }
    let pendingMfa = false;
    if (!factor && organizationId && (orgPolicy.mfa.requiredForAll || orgPolicy.mfa.requiredForRoles.length > 0)) {
      if (orgPolicy.mfa.requiredForAll) pendingMfa = true;
      else {
        const roles = await trx('user_role_assignments as ura')
          .join('organization_memberships as m', 'm.id', 'ura.membership_id')
          .join('roles as r', 'r.id', 'ura.role_id')
          .where({ 'm.user_id': user.id, 'm.organization_id': organizationId })
          .select('r.key');
        pendingMfa = roles.some((r) => orgPolicy.mfa.requiredForRoles.includes(r.key));
      }
    }

    await trx('users').where({ id: user.id }).update({ failed_login_count: 0, locked_until: null });
    const bundle = await createSession(svc, trx, user, organizationId, orgPolicy, m, { pendingMfa, mfaVerified });
    await recordSecurityEvent(trx, rm(m, organizationId, user.id), 'login', 'success', { mfa: mfaVerified });
    await recordAudit(trx, { ...rm(m, organizationId, user.id), actorId: user.id }, { action: 'auth.login', resourceType: 'session', resourceId: bundle.sessionId });
    return { failure: null, value: { ...bundle, organizations: memberships.map(({ id, name, code }) => ({ id, name, code })) } };
  });
  // Failures are returned (not thrown) from inside the transaction so lockout counters and security
  // events commit; the error is raised only after the transaction has completed.
  if (result.failure) throw result.failure;
  return result.value;
}

/** Rotating refresh tokens. A replayed (already-rotated) token revokes the whole token family (F-005). */
export async function refresh(svc: Services, token: string, m: ReqMeta): Promise<TokenBundle> {
  const now = svc.now();
  const hash = sha256(token);
  const outcome = await withPlatformScope(svc.db, 'refresh', async (trx) => {
    const session = await trx('sessions').where({ refresh_token_hash: hash }).forUpdate().first();
    if (!session) {
      const used = await trx('used_refresh_tokens').where({ token_hash: hash }).first();
      if (used) {
        const s = await trx('sessions').where({ id: used.session_id }).first();
        if (s) {
          await trx('sessions').where({ family_id: s.family_id }).whereNull('revoked_at').update({ revoked_at: now, revoked_reason: 'refresh_reuse_detected' });
          await recordSecurityEvent(trx, rm(m, s.active_organization_id, s.user_id), 'refresh_reuse_detected', 'denied');
        }
      }
      return { ok: false as const };
    }
    if (session.revoked_at || new Date(session.idle_expires_at) < now || new Date(session.absolute_expires_at) < now) return { ok: false as const };
    const user = await trx('users').where({ id: session.user_id, status: 'active' }).first();
    if (!user) return { ok: false as const };
    if (session.active_organization_id) {
      const org = await trx('organizations').where({ id: session.active_organization_id }).first();
      if (org && org.status !== 'active' && !user.is_platform_admin) return { ok: false as const };
    }
    const next = randomToken(48);
    await trx('used_refresh_tokens').insert({ token_hash: hash, session_id: session.id });
    const idleMs = new Date(session.idle_expires_at).getTime() - new Date(session.last_seen_at).getTime();
    await trx('sessions').where({ id: session.id }).update({
      refresh_token_hash: sha256(next), rotated_at: now, last_seen_at: now,
      idle_expires_at: new Date(Math.min(now.getTime() + idleMs, new Date(session.absolute_expires_at).getTime())),
    });
    const accessToken = await signAccessToken(svc.env.JWT_SECRET, {
      sub: user.id, sid: session.id, org: session.active_organization_id, pv: user.permission_version,
    });
    return {
      ok: true as const,
      bundle: { accessToken, refreshToken: next, expiresIn: ACCESS_TTL_SECONDS, sessionId: session.id, organizationId: session.active_organization_id as string | null, mfaSetupRequired: !!session.pending_mfa },
    };
  });
  if (!outcome.ok) throw unauth('Invalid refresh token');
  return outcome.bundle;
}

export async function logout(svc: Services, sessionId: string, userId: string, m: ReqMeta): Promise<void> {
  await withPlatformScope(svc.db, 'logout', async (trx) => {
    await trx('sessions').where({ id: sessionId, user_id: userId }).whereNull('revoked_at').update({ revoked_at: svc.now(), revoked_reason: 'logout' });
    await recordSecurityEvent(trx, rm(m, null, userId), 'logout');
  });
}

export async function logoutAll(svc: Services, userId: string, m: ReqMeta): Promise<void> {
  await withPlatformScope(svc.db, 'logout-all', async (trx) => {
    await revokeAllSessions(trx, userId, 'logout_all', svc.now());
    await recordSecurityEvent(trx, rm(m, null, userId), 'logout_all');
  });
}

export async function switchOrganization(svc: Services, sessionId: string, userId: string, organizationId: string, m: ReqMeta): Promise<TokenBundle> {
  return withPlatformScope(svc.db, 'switch-org', async (trx) => {
    const mem = await trx('organization_memberships as m').join('organizations as o', 'o.id', 'm.organization_id')
      .where({ 'm.user_id': userId, 'm.organization_id': organizationId, 'm.status': 'active' })
      .select('o.status as org_status').first();
    const user = await trx('users').where({ id: userId }).first();
    if (!mem || (mem.org_status !== 'active' && !user.is_platform_admin)) throw new AppError('NOT_FOUND', 'Organization not found');
    await trx('sessions').where({ id: sessionId }).update({ active_organization_id: organizationId });
    const accessToken = await signAccessToken(svc.env.JWT_SECRET, { sub: userId, sid: sessionId, org: organizationId, pv: user.permission_version });
    await recordSecurityEvent(trx, rm(m, organizationId, userId), 'switch_organization');
    const s = await trx('sessions').where({ id: sessionId }).first();
    return { accessToken, refreshToken: '', expiresIn: ACCESS_TTL_SECONDS, sessionId, organizationId, mfaSetupRequired: !!s.pending_mfa };
  });
}

// ---- MFA -----------------------------------------------------------------------------------------------------

export async function mfaSetup(svc: Services, userId: string): Promise<{ secret: string; otpauthUrl: string }> {
  return withPlatformScope(svc.db, 'mfa-setup', async (trx) => {
    const user = await trx('users').where({ id: userId }).first();
    const existing = await trx('mfa_factors').where({ user_id: userId, type: 'totp' }).first();
    if (existing?.confirmed_at) throw new AppError('CONFLICT', 'MFA is already enabled');
    const secret = newTotpSecret();
    await trx('mfa_factors').where({ user_id: userId, type: 'totp' }).delete();
    await trx('mfa_factors').insert({ id: newId(), user_id: userId, type: 'totp', secret_encrypted: encrypt(svc.keys, secret) });
    return { secret, otpauthUrl: totpUri(secret, user.email) };
  });
}

function newRecoveryCodes(n = 10): string[] {
  return Array.from({ length: n }, () => randomToken(6).toLowerCase().replace(/[-_]/g, 'x'));
}

async function storeRecoveryCodes(trx: Trx, userId: string): Promise<string[]> {
  const codes = newRecoveryCodes();
  await trx('mfa_recovery_codes').where({ user_id: userId }).delete();
  await trx('mfa_recovery_codes').insert(codes.map((c) => ({ id: newId(), user_id: userId, code_hash: sha256(c) })));
  return codes;
}

export async function mfaConfirm(svc: Services, userId: string, sessionId: string, code: string, m: ReqMeta): Promise<string[]> {
  return withPlatformScope(svc.db, 'mfa-confirm', async (trx) => {
    const f = await trx('mfa_factors').where({ user_id: userId, type: 'totp' }).whereNull('confirmed_at').first();
    if (!f || !verifyTotp(decrypt(svc.keys, f.secret_encrypted), code)) {
      throw new AppError('VALIDATION_FAILED', 'Invalid code', [{ field: 'code', issue: 'invalid' }]);
    }
    await trx('mfa_factors').where({ id: f.id }).update({ confirmed_at: svc.now() });
    await trx('sessions').where({ id: sessionId }).update({ pending_mfa: false, mfa_verified: true });
    await recordSecurityEvent(trx, rm(m, null, userId), 'mfa_enabled');
    return storeRecoveryCodes(trx, userId);
  });
}

async function requireMfaProof(svc: Services, trx: Trx, userId: string, password: string | undefined, code: string) {
  const user = await trx('users').where({ id: userId }).first();
  if (password !== undefined && !(await verifyPassword(user.password_hash, password))) throw new AppError('FORBIDDEN', 'Password confirmation failed');
  const f = await trx('mfa_factors').where({ user_id: userId }).whereNotNull('confirmed_at').first();
  if (!f) throw new AppError('CONFLICT', 'MFA is not enabled');
  const ok = (await checkSecondFactor(svc, trx, userId, code)) || (await consumeRecoveryCode(trx, userId, code));
  if (!ok) throw new AppError('FORBIDDEN', 'Invalid code');
}

/** Verifies a TOTP or emailed code for a session that must pass MFA. */
export async function mfaVerifyCode(svc: Services, userId: string, sessionId: string, code: string): Promise<boolean> {
  return withPlatformScope(svc.db, 'mfa-verify', async (trx) => {
    const ok = await checkSecondFactor(svc, trx, userId, code);
    if (ok) await trx('sessions').where({ id: sessionId }).update({ mfa_verified: true, pending_mfa: false });
    return ok;
  });
}

/** Mails a sign-in style code to the signed-in user (to verify a session, disable MFA or regenerate recovery codes). */
export async function mfaEmailSend(svc: Services, userId: string): Promise<void> {
  await withPlatformScope(svc.db, 'mfa-email-send', async (trx) => {
    const factor = await trx('mfa_factors').where({ user_id: userId, type: 'email_otp' }).whereNotNull('confirmed_at').first();
    if (!factor) throw new AppError('CONFLICT', 'Email code MFA is not enabled');
    const user = await trx('users').where({ id: userId }).first();
    await sendEmailOtp(svc, trx, user, 'mfa_email_login');
  });
}

/** Starts email-code enrolment: mails a code to the account address. */
export async function mfaEmailSetup(svc: Services, userId: string): Promise<void> {
  await withPlatformScope(svc.db, 'mfa-email-setup', async (trx) => {
    const existing = await trx('mfa_factors').where({ user_id: userId, type: 'email_otp' }).whereNotNull('confirmed_at').first();
    if (existing) throw new AppError('CONFLICT', 'Email code MFA is already enabled');
    const user = await trx('users').where({ id: userId }).first();
    await sendEmailOtp(svc, trx, user, 'mfa_email_enrol');
  });
}

/** Confirms the emailed code and activates the factor. Returns recovery codes only when the user has none yet. */
export async function mfaEmailConfirm(svc: Services, userId: string, sessionId: string, code: string, m: ReqMeta): Promise<string[]> {
  return withPlatformScope(svc.db, 'mfa-email-confirm', async (trx) => {
    if (!(await consumeEmailOtp(svc, trx, userId, 'mfa_email_enrol', code))) {
      throw new AppError('VALIDATION_FAILED', 'Invalid code', [{ field: 'code', issue: 'invalid' }]);
    }
    await trx('mfa_factors').where({ user_id: userId, type: 'email_otp' }).delete();
    await trx('mfa_factors').insert({
      id: newId(), user_id: userId, type: 'email_otp', secret_encrypted: encrypt(svc.keys, 'email'), confirmed_at: svc.now(),
    });
    await trx('sessions').where({ id: sessionId }).update({ pending_mfa: false, mfa_verified: true });
    await recordSecurityEvent(trx, rm(m, null, userId), 'mfa_enabled', 'success', { method: 'email_otp' });
    const unused = await trx('mfa_recovery_codes').where({ user_id: userId }).whereNull('used_at').first();
    return unused ? [] : storeRecoveryCodes(trx, userId);
  });
}

// ---- public config, invitation preview, security overview -----------------------------------------------------

export async function publicConfig(svc: Services) {
  const policy = await loadSecurityPolicy(svc.db, null);
  return {
    selfRegistration: { enabled: true, kinds: ['individual', 'organization'] as string[] },
    requireEmailVerification: true,
    passwordPolicy: {
      minLength: policy.password.minLength, requireClasses: policy.password.requireClasses, historyDepth: policy.password.historyDepth,
    },
    mfaMethods: ['totp', 'email_otp'] as string[],
    encryptedLogin: true,
  };
}

export type InvitationState = 'valid' | 'invalid' | 'expired' | 'used' | 'revoked';

/** Read-only look at an invitation so the UI can pick "set a password" vs "sign in" before submitting. */
export async function previewInvitation(svc: Services, token: string) {
  return withPlatformScope(svc.db, 'invitation-preview', async (trx) => {
    const inv = await trx('invitations as i').join('organizations as o', 'o.id', 'i.organization_id')
      .where({ 'i.token_hash': sha256(token) })
      .select('i.email', 'i.status', 'i.expires_at', 'o.name as organization_name').first();
    if (!inv) return { state: 'invalid' as InvitationState };
    let state: InvitationState = 'valid';
    if (inv.status === 'accepted') state = 'used';
    else if (inv.status === 'revoked') state = 'revoked';
    else if (inv.status === 'expired' || new Date(inv.expires_at) <= svc.now()) state = 'expired';
    if (state !== 'valid') return { state };
    const existing = await trx('users').where({ email: String(inv.email).toLowerCase() }).first();
    return { state, email: inv.email as string, organizationName: inv.organization_name as string, accountExists: !!existing };
  });
}

export async function securityOverview(svc: Services, userId: string, organizationId: string | null) {
  return withPlatformScope(svc.db, 'security-overview', async (trx) => {
    const user = await trx('users').where({ id: userId }).first();
    const factors: { type: string }[] = await trx('mfa_factors').where({ user_id: userId }).whereNotNull('confirmed_at');
    const remaining = await trx('mfa_recovery_codes').where({ user_id: userId }).whereNull('used_at').count<{ count: string }[]>('id as count');
    const events = await trx('security_events').where({ user_id: userId }).orderBy('occurred_at', 'desc').limit(10)
      .select('id', 'event', 'outcome', 'ip', 'user_agent', 'occurred_at');
    const policy = await loadSecurityPolicy(svc.db, organizationId);
    return {
      emailVerified: !!user.email_verified_at,
      passwordChangedAt: user.password_changed_at ? new Date(user.password_changed_at).toISOString() : null,
      mfaEnabled: factors.length > 0,
      mfaMethods: factors.map((f) => f.type),
      recoveryCodesRemaining: Number(remaining[0]?.count ?? 0),
      mfaRequiredByOrganization: !!organizationId && (policy.mfa.requiredForAll || policy.mfa.requiredForRoles.length > 0),
      recentEvents: events.map((e) => ({
        id: e.id as string, event: e.event as string, outcome: e.outcome as string, ip: (e.ip as string | null) ?? null,
        userAgent: (e.user_agent as string | null) ?? null, occurredAt: new Date(e.occurred_at).toISOString(),
      })),
    };
  });
}

export async function mfaDisable(svc: Services, userId: string, password: string, code: string, m: ReqMeta): Promise<void> {
  await withPlatformScope(svc.db, 'mfa-disable', async (trx) => {
    await requireMfaProof(svc, trx, userId, password, code);
    await trx('mfa_factors').where({ user_id: userId }).delete();
    await trx('mfa_recovery_codes').where({ user_id: userId }).delete();
    await recordSecurityEvent(trx, rm(m, null, userId), 'mfa_disabled');
  });
}

export async function regenerateRecoveryCodes(svc: Services, userId: string, code: string, m: ReqMeta): Promise<string[]> {
  return withPlatformScope(svc.db, 'mfa-recovery', async (trx) => {
    await requireMfaProof(svc, trx, userId, undefined, code);
    const codes = await storeRecoveryCodes(trx, userId);
    await recordSecurityEvent(trx, rm(m, null, userId), 'mfa_recovery_regenerated');
    return codes;
  });
}

// ---- invitations (accept) -----------------------------------------------------------------------------------

export async function acceptInvitation(
  svc: Services,
  input: { token: string; name?: string; password?: string },
  authedUser: { id: string; email: string } | null,
  m: ReqMeta,
): Promise<{ organizationId: string; userId: string }> {
  return withPlatformScope(svc.db, 'invitation-accept', async (trx) => {
    const inv = await trx('invitations').where({ token_hash: sha256(input.token), status: 'pending' }).where('expires_at', '>', svc.now()).first();
    if (!inv) throw new AppError('VALIDATION_FAILED', 'Invalid or expired invitation', [{ field: 'token', issue: 'invalid' }]);
    let user = await trx('users').where({ email: inv.email.toLowerCase() }).first();
    if (user) {
      if (!authedUser || authedUser.id !== user.id) throw unauth('Sign in with the invited account to accept this invitation');
    } else {
      if (!input.password || !input.name) {
        throw new AppError('VALIDATION_FAILED', 'name and password are required for new accounts', [
          { field: 'password', issue: 'required' }, { field: 'name', issue: 'required' },
        ]);
      }
      const policy = await loadSecurityPolicy(svc.db, inv.organization_id);
      await enforcePasswordPolicy(trx, input.password, policy, { email: inv.email });
      const hash = await hashPassword(input.password);
      const id = newId();
      await trx('users').insert({
        id, email: inv.email.toLowerCase(), name: input.name, password_hash: hash, password_changed_at: svc.now(),
        email_verified_at: svc.now(), // the invitation token proves control of the mailbox
      });
      await trx('password_history').insert({ id: newId(), user_id: id, password_hash: hash });
      user = await trx('users').where({ id }).first();
    }
    await trx.raw(`SELECT set_config('app.current_org', ?, true)`, [inv.organization_id]);
    const existing = await trx('organization_memberships').where({ organization_id: inv.organization_id, user_id: user.id }).first();
    let membershipId: string;
    if (existing) {
      membershipId = existing.id;
      await trx('organization_memberships').where({ id: existing.id }).update({ status: 'active', updated_at: svc.now() });
    } else {
      membershipId = newId();
      await trx('organization_memberships').insert({
        id: membershipId, organization_id: inv.organization_id, user_id: user.id, status: 'active',
        joined_at: svc.now(), created_by: inv.invited_by,
      });
    }
    const roleId = inv.role_id ?? SYSTEM_ROLE_IDS.viewer; // least privilege default (F-189)
    await trx('user_role_assignments').insert({
      id: newId(), organization_id: inv.organization_id, membership_id: membershipId, role_id: roleId,
      scope_type: 'organization', created_by: inv.invited_by,
    }).onConflict().ignore();
    await trx('access_history').insert({
      id: newId(), organization_id: inv.organization_id, actor_id: inv.invited_by, subject_user_id: user.id,
      role_id: roleId, change: 'granted', reason: 'invitation accepted',
    });
    await trx('invitations').where({ id: inv.id }).update({ status: 'accepted', accepted_at: svc.now() });
    await trx('users').where({ id: user.id }).increment('permission_version', 1);
    await recordAudit(trx, { organizationId: inv.organization_id, actorId: user.id, correlationId: m.requestId, ip: m.ip, userAgent: m.userAgent },
      { action: 'invitation.accepted', resourceType: 'invitation', resourceId: inv.id });
    await recordSecurityEvent(trx, rm(m, inv.organization_id, user.id), 'invitation_accepted');
    return { organizationId: inv.organization_id as string, userId: user.id as string };
  });
}
