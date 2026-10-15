import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getCtx, createActor, tokenFromMail, STRONG_PASSWORD, uniq, currentTotp, type TestCtx } from './helpers/app.js';

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await getCtx();
});
afterAll(async () => {
  await ctx.close();
});

describe('auth', () => {
  it('registers, verifies, logs in and returns permissions server-side', async () => {
    const a = await createActor(ctx);
    const me = await ctx.api.get('/api/v1/auth/me').set(a.auth);
    expect(me.status).toBe(200);
    expect(me.body.data.organizationId).toBe(a.organizationId);
    expect(me.body.data.permissions.length).toBeGreaterThan(0);
  });

  it('does not reveal whether an email exists (register / forgot / login)', async () => {
    const a = await createActor(ctx);
    const dup = await ctx.api.post('/api/v1/auth/register').send({ kind: 'individual', name: 'Dup', email: a.email, password: STRONG_PASSWORD });
    const fresh = await ctx.api.post('/api/v1/auth/register').send({ kind: 'individual', name: 'New', email: `${uniq()}@example.test`, password: STRONG_PASSWORD });
    expect(dup.status).toBe(fresh.status);
    expect(dup.body).toEqual(fresh.body);
    const f1 = await ctx.api.post('/api/v1/auth/forgot-password').send({ email: a.email });
    const f2 = await ctx.api.post('/api/v1/auth/forgot-password').send({ email: 'nobody@example.test' });
    expect(f1.status).toBe(f2.status);
    const bad1 = await ctx.api.post('/api/v1/auth/login').send({ email: a.email, password: 'wrong-Password-1!' });
    const bad2 = await ctx.api.post('/api/v1/auth/login').send({ email: 'nobody@example.test', password: 'wrong-Password-1!' });
    expect(bad1.status).toBe(401);
    expect(bad1.body.errorMessage[0].msg).toBe(bad2.body.errorMessage[0].msg);
  });

  it('rejects weak passwords with the standard error contract', async () => {
    const r = await ctx.api.post('/api/v1/auth/register').send({ kind: 'individual', name: 'X', email: `${uniq()}@example.test`, password: 'short' });
    expect(r.status).toBe(422);
    expect(r.body.errorMessage[0].code).toBe('VALIDATION_FAILED');
    expect(r.body.requestId).toBeTruthy();
  });

  it('locks the account progressively after repeated failures', async () => {
    const a = await createActor(ctx);
    for (let i = 0; i < 5; i++) await ctx.api.post('/api/v1/auth/login').send({ email: a.email, password: 'Wrong-Password-9!' });
    const r = await ctx.api.post('/api/v1/auth/login').send({ email: a.email, password: STRONG_PASSWORD });
    expect(r.status).toBe(401); // locked even with the right password
    const row = await ctx.svc.db('users').where({ email: a.email }).first();
    expect(row.locked_until).toBeTruthy();
  });

  it('rotates refresh tokens and revokes the family on reuse', async () => {
    const a = await createActor(ctx);
    const r1 = await ctx.api.post('/api/v1/auth/refresh').send({ refreshToken: a.refreshToken });
    expect(r1.status).toBe(200);
    const reuse = await ctx.api.post('/api/v1/auth/refresh').send({ refreshToken: a.refreshToken });
    expect(reuse.status).toBe(401);
    const afterReuse = await ctx.api.post('/api/v1/auth/refresh').send({ refreshToken: r1.body.data.refreshToken });
    expect(afterReuse.status).toBe(401); // whole family revoked
    expect((await ctx.api.get('/api/v1/auth/me').set(a.auth)).status).toBe(401);
  });

  it('logout revokes the session immediately', async () => {
    const a = await createActor(ctx);
    expect((await ctx.api.post('/api/v1/auth/logout').set(a.auth)).status).toBe(200);
    expect((await ctx.api.get('/api/v1/auth/me').set(a.auth)).status).toBe(401);
  });

  it('password reset revokes sessions, enforces history, and is single-use', async () => {
    const a = await createActor(ctx);
    await ctx.api.post('/api/v1/auth/forgot-password').send({ email: a.email });
    const token = tokenFromMail(ctx.mail, a.email);
    const same = await ctx.api.post('/api/v1/auth/reset-password').send({ token, newPassword: STRONG_PASSWORD });
    expect(same.status).toBe(422);
    const ok = await ctx.api.post('/api/v1/auth/reset-password').send({ token, newPassword: 'Another-Strong-Pass-77' });
    expect(ok.status).toBe(200);
    expect((await ctx.api.get('/api/v1/auth/me').set(a.auth)).status).toBe(401);
    const reuse = await ctx.api.post('/api/v1/auth/reset-password').send({ token, newPassword: 'Yet-Another-Pass-88' });
    expect(reuse.status).toBe(422);
  });

  it('enrols TOTP MFA, requires it at login, accepts each recovery code once', async () => {
    const a = await createActor(ctx);
    const setup = await ctx.api.post('/api/v1/auth/mfa/setup').set(a.auth);
    expect(setup.status).toBe(200);
    const confirm = await ctx.api.post('/api/v1/auth/mfa/confirm').set(a.auth).send({ code: currentTotp(setup.body.data.secret) });
    expect(confirm.status).toBe(200);
    const codes: string[] = confirm.body.data.recoveryCodes;
    expect(codes).toHaveLength(10);
    const noCode = await ctx.api.post('/api/v1/auth/login').send({ email: a.email, password: STRONG_PASSWORD });
    expect(noCode.status).toBe(401);
    expect(noCode.body.errorMessage[1].issue).toBe('mfa_required');
    const withTotp = await ctx.api.post('/api/v1/auth/login').send({ email: a.email, password: STRONG_PASSWORD, mfaCode: currentTotp(setup.body.data.secret) });
    expect(withTotp.status).toBe(200);
    const rec = await ctx.api.post('/api/v1/auth/login').send({ email: a.email, password: STRONG_PASSWORD, mfaCode: codes[0] });
    expect(rec.status).toBe(200);
    const recAgain = await ctx.api.post('/api/v1/auth/login').send({ email: a.email, password: STRONG_PASSWORD, mfaCode: codes[0] });
    expect(recAgain.status).toBe(401);
  });
});

