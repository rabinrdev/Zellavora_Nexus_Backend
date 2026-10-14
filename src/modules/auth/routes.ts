import { z } from 'zod';
import { defineRoute, type HandlerCtx } from '../../platform/http/route.js';
import { authenticate } from '../../platform/http/authn.js';
import type { RateLimiter } from '../../platform/rate-limit.js';
import { withUser } from '../../platform/scope.js';
import * as svc from './service.js';

const email = z.string().trim().toLowerCase().email().max(254);
const password = z.string().min(1).max(256);
const tokenField = z.string().min(10).max(512);
const MODULE = 'auth';
const message = z.object({ message: z.string() });

const meta = (c: HandlerCtx) => ({ ip: c.ip, userAgent: c.userAgent, requestId: c.requestId });
const limiter = (c: HandlerCtx) => c.res.app.locals.rateLimiter as RateLimiter;
const ACCEPTED = { message: 'If the request can be processed, you will receive an email shortly.' };

const tokenBundle = z.object({
  accessToken: z.string(), refreshToken: z.string(), expiresIn: z.number(), sessionId: z.string(),
  organizationId: z.string().nullable(), mfaSetupRequired: z.boolean(),
});

defineRoute({
  method: 'post', path: '/auth/register', module: MODULE, summary: 'Register an individual or organization',
  access: 'public', rateLimit: 'auth',
  body: z.object({
    kind: z.enum(['individual', 'organization']),
    name: z.string().trim().min(1).max(120),
    email, password,
    organizationName: z.string().trim().min(2).max(120).optional(),
    organizationCode: z.string().trim().toLowerCase().max(40).optional(),
  }),
  response: message,
  async handler(c) {
    await limiter(c).consume('auth', `acct:${c.body.email}`);
    await svc.register(c.svc, c.body, meta(c));
    return { status: 202, data: ACCEPTED };
  },
});

defineRoute({
  method: 'post', path: '/auth/verify-email', module: MODULE, summary: 'Verify an email address',
  access: 'public', rateLimit: 'auth', body: z.object({ token: tokenField }), response: message,
  async handler(c) {
    await svc.verifyEmail(c.svc, c.body.token, meta(c));
    return { status: 200, data: { message: 'Email verified' } };
  },
});

defineRoute({
  method: 'post', path: '/auth/resend-verification', module: MODULE, summary: 'Resend the verification email',
  access: 'public', rateLimit: 'auth', body: z.object({ email }), response: message,
  async handler(c) {
    await limiter(c).consume('auth', `acct:${c.body.email}`);
    await svc.resendVerification(c.svc, c.body.email);
    return { status: 202, data: ACCEPTED };
  },
});

defineRoute({
  method: 'post', path: '/auth/login', module: MODULE, summary: 'Sign in with email and password',
  access: 'public', rateLimit: 'auth',
  body: z.object({
    email, password,
    organizationCode: z.string().trim().max(40).optional(),
    mfaCode: z.string().trim().max(64).optional(),
  }),
  response: tokenBundle.extend({
    organizations: z.array(z.object({ id: z.string(), name: z.string(), code: z.string() })),
  }),
  async handler(c) {
    await limiter(c).consume('auth', `acct:${c.body.email}`);
    return { status: 200, data: await svc.login(c.svc, c.body, meta(c)) };
  },
});

defineRoute({
  method: 'post', path: '/auth/refresh', module: MODULE, summary: 'Rotate the refresh token',
  access: 'public', rateLimit: 'auth', body: z.object({ refreshToken: z.string().min(20).max(512) }),
  response: tokenBundle,
  async handler(c) {
    return { status: 200, data: await svc.refresh(c.svc, c.body.refreshToken, meta(c)) };
  },
});

defineRoute({
  method: 'post', path: '/auth/logout', module: MODULE, summary: 'Revoke the current session',
  access: 'authenticated', scope: 'user', response: message,
  async handler(c) {
    await svc.logout(c.svc, c.auth!.sessionId, c.auth!.userId, meta(c));
    return { status: 200, data: { message: 'Signed out' } };
  },
});

defineRoute({
  method: 'post', path: '/auth/logout-all', module: MODULE, summary: 'Revoke all sessions of the user',
  access: 'authenticated', scope: 'user', response: message,
  async handler(c) {
    await svc.logoutAll(c.svc, c.auth!.userId, meta(c));
    return { status: 200, data: { message: 'Signed out everywhere' } };
  },
});

defineRoute({
  method: 'post', path: '/auth/forgot-password', module: MODULE, summary: 'Request a password reset',
  access: 'public', rateLimit: 'auth', body: z.object({ email }), response: message,
  async handler(c) {
    await limiter(c).consume('auth', `acct:${c.body.email}`);
    await svc.forgotPassword(c.svc, c.body.email, meta(c));
    return { status: 202, data: ACCEPTED };
  },
});

defineRoute({
  method: 'post', path: '/auth/reset-password', module: MODULE, summary: 'Complete a password reset',
  access: 'public', rateLimit: 'auth', body: z.object({ token: tokenField, newPassword: password }),
  response: message,
  async handler(c) {
    await svc.resetPassword(c.svc, c.body.token, c.body.newPassword, meta(c));
    return { status: 200, data: { message: 'Password updated' } };
  },
});

defineRoute({
  method: 'post', path: '/auth/invitations/accept', module: MODULE, summary: 'Accept an organization invitation',
  access: 'public', rateLimit: 'invitation',
  body: z.object({ token: tokenField, name: z.string().trim().min(1).max(120).optional(), password: password.optional() }),
  response: z.object({ organizationId: z.string(), userId: z.string() }),
  async handler(c) {
    let authed: { id: string; email: string } | null = null;
    if (c.req.get('authorization')) {
      const a = await authenticate(c.svc, c.req);
      const u = await c.svc.db('users').where({ id: a.userId }).first();
      authed = { id: a.userId, email: u.email };
    }
    return { status: 200, data: await svc.acceptInvitation(c.svc, c.body, authed, meta(c)) };
  },
});

defineRoute({
  method: 'post', path: '/auth/switch-organization', module: MODULE, summary: 'Switch the active organization',
  access: 'authenticated', scope: 'user', allowSuspendedTenant: true, body: z.object({ organizationId: z.string().uuid() }),
  response: tokenBundle.omit({ refreshToken: true }).extend({ refreshToken: z.string() }),
  async handler(c) {
    return { status: 200, data: await svc.switchOrganization(c.svc, c.auth!.sessionId, c.auth!.userId, c.body.organizationId, meta(c)) };
  },
});

defineRoute({
  method: 'get', path: '/auth/me', module: MODULE, summary: 'Current user, active organization and permissions',
  access: 'authenticated', scope: 'user', allowPendingMfa: true, allowSuspendedTenant: true,
  response: z.object({
    user: z.object({ id: z.string(), email: z.string(), name: z.string(), locale: z.string(), timezone: z.string(), mfaEnabled: z.boolean() }),
    organizationId: z.string().nullable(),
    organizations: z.array(z.object({ id: z.string(), name: z.string(), code: z.string(), status: z.string() })),
    permissions: z.array(z.string()),
    sessionId: z.string(),
  }),
  async handler(c) {
    const a = c.auth!;
    const user = await c.trx('users').where({ id: a.userId }).first();
    const mfa = await c.trx('mfa_factors').where({ user_id: a.userId }).whereNotNull('confirmed_at').first();
    const orgs = (await c.trx.raw(
      `SELECT o.id, o.name, o.code::text AS code, o.status FROM organization_memberships m
         JOIN organizations o ON o.id = m.organization_id WHERE m.user_id = ? AND m.status = 'active' ORDER BY o.name`,
      [a.userId])).rows;
    return {
      status: 200,
      data: {
        user: { id: user.id, email: user.email, name: user.name, locale: user.locale, timezone: user.timezone, mfaEnabled: !!mfa },
        organizationId: a.organizationId, organizations: orgs, permissions: [...a.permissions].sort(), sessionId: a.sessionId,
      },
    };
  },
});

defineRoute({
  method: 'get', path: '/auth/sessions', module: MODULE, summary: 'List my active sessions',
  access: 'authenticated', scope: 'user',
  response: z.array(z.object({ id: z.string(), ip: z.string().nullable(), userAgent: z.string().nullable(), createdAt: z.string(), lastSeenAt: z.string(), current: z.boolean() })),
  async handler(c) {
    const rows = await c.trx('sessions').where({ user_id: c.auth!.userId }).whereNull('revoked_at')
      .where('absolute_expires_at', '>', c.svc.now()).orderBy('last_seen_at', 'desc');
    return {
      data: rows.map((r) => ({
        id: r.id, ip: r.ip, userAgent: r.user_agent, createdAt: new Date(r.created_at).toISOString(),
        lastSeenAt: new Date(r.last_seen_at).toISOString(), current: r.id === c.auth!.sessionId,
      })),
    };
  },
});

defineRoute({
  method: 'delete', path: '/auth/sessions/:id', module: MODULE, summary: 'Revoke one of my sessions',
  access: 'authenticated', scope: 'user', params: z.object({ id: z.string().uuid() }),
  async handler(c) {
    const n = await c.trx('sessions').where({ id: c.params.id, user_id: c.auth!.userId }).whereNull('revoked_at')
      .update({ revoked_at: c.svc.now(), revoked_reason: 'revoked_by_user' });
    if (n === 0) throw new (await import('../../platform/errors.js')).AppError('NOT_FOUND', 'Session not found');
    return { status: 204 };
  },
});

const mfaCode = z.string().trim().min(6).max(64);

defineRoute({
  method: 'post', path: '/auth/mfa/setup', module: MODULE, summary: 'Begin TOTP enrolment',
  access: 'authenticated', scope: 'user', allowPendingMfa: true, rateLimit: 'mfa',
  response: z.object({ secret: z.string(), otpauthUrl: z.string() }),
  async handler(c) {
    return { status: 200, data: await svc.mfaSetup(c.svc, c.auth!.userId) };
  },
});

defineRoute({
  method: 'post', path: '/auth/mfa/confirm', module: MODULE, summary: 'Confirm TOTP enrolment; returns recovery codes once',
  access: 'authenticated', scope: 'user', allowPendingMfa: true, rateLimit: 'mfa', body: z.object({ code: mfaCode }),
  response: z.object({ recoveryCodes: z.array(z.string()) }),
  async handler(c) {
    const codes = await svc.mfaConfirm(c.svc, c.auth!.userId, c.auth!.sessionId, c.body.code, meta(c));
    return { status: 200, data: { recoveryCodes: codes } };
  },
});

defineRoute({
  method: 'post', path: '/auth/mfa/verify', module: MODULE, summary: 'Verify a TOTP or recovery code for the session',
  access: 'authenticated', scope: 'user', allowPendingMfa: true, rateLimit: 'mfa', body: z.object({ code: mfaCode }),
  response: z.object({ verified: z.boolean() }),
  async handler(c) {
    const f = await c.trx('mfa_factors').where({ user_id: c.auth!.userId }).whereNotNull('confirmed_at').first();
    const { decrypt } = await import('../../platform/crypto.js');
    const { verifyTotp } = await import('../../platform/auth/totp.js');
    const ok = !!f && verifyTotp(decrypt(c.svc.keys, f.secret_encrypted), c.body.code);
    if (ok) await c.trx('sessions').where({ id: c.auth!.sessionId }).update({ mfa_verified: true, pending_mfa: false });
    return { status: 200, data: { verified: ok } };
  },
});

defineRoute({
  method: 'post', path: '/auth/mfa/disable', module: MODULE, summary: 'Disable MFA (password + code required)',
  access: 'authenticated', scope: 'user', rateLimit: 'mfa', body: z.object({ password, code: mfaCode }), response: message,
  async handler(c) {
    await svc.mfaDisable(c.svc, c.auth!.userId, c.body.password, c.body.code, meta(c));
    return { status: 200, data: { message: 'MFA disabled' } };
  },
});

defineRoute({
  method: 'post', path: '/auth/mfa/recovery-codes/regenerate', module: MODULE, summary: 'Regenerate recovery codes',
  access: 'authenticated', scope: 'user', rateLimit: 'mfa', body: z.object({ code: mfaCode }),
  response: z.object({ recoveryCodes: z.array(z.string()) }),
  async handler(c) {
    return { status: 200, data: { recoveryCodes: await svc.regenerateRecoveryCodes(c.svc, c.auth!.userId, c.body.code, meta(c)) } };
  },
});

void withUser;
