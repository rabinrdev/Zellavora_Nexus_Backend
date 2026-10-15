import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createActor, getCtx, STRONG_PASSWORD, type TestCtx } from './helpers/app.js';

let ctx: TestCtx;
beforeAll(async () => { ctx = await getCtx(); });
afterAll(async () => { await ctx.close(); });

const sixDigits = /\b(\d{6})\b/;

describe('public config, invitation preview, security overview', () => {
  it('GET /auth/config is public', async () => {
    const r = await ctx.api.get('/api/v1/auth/config');
    expect(r.status).toBe(200);
    expect(r.body.data.passwordPolicy.minLength).toBeGreaterThanOrEqual(8);
    expect(r.body.data.mfaMethods).toContain('email_otp');
  });

  it('gettoken is a bare [key, iv] hex array', async () => {
    const r = await ctx.api.get('/api/v1/auth/gettoken');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);
    expect(r.body[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(r.body[1]).toMatch(/^[0-9a-f]{32}$/);
  });

  it('invitation preview reports an unknown token as invalid', async () => {
    const r = await ctx.api.post('/api/v1/auth/invitations/preview').send({ token: 'z'.repeat(43) });
    expect(r.status).toBe(200);
    expect(r.body.data.state).toBe('invalid');
  });

  it('security overview needs auth and describes the account', async () => {
    expect((await ctx.api.get('/api/v1/auth/security')).status).toBe(401);
    const a = await createActor(ctx, { kind: 'individual' });
    const r = await ctx.api.get('/api/v1/auth/security').set(a.auth);
    expect(r.status).toBe(200);
    expect(r.body.data.mfaEnabled).toBe(false);
    expect(r.body.data.recentEvents.length).toBeGreaterThan(0);
  });
});

describe('email one-time-code MFA', () => {
  it('enrols, is required at login, and can be used to sign in', async () => {
    const a = await createActor(ctx, { kind: 'individual' });
    expect((await ctx.api.post('/api/v1/auth/mfa/email/confirm').set(a.auth).send({ code: '000000' })).status).toBe(422);

    expect((await ctx.api.post('/api/v1/auth/mfa/email/setup').set(a.auth)).status).toBe(200);
    const enrolCode = sixDigits.exec(ctx.mail.last(a.email)!.text)![1]!;
    const confirm = await ctx.api.post('/api/v1/auth/mfa/email/confirm').set(a.auth).send({ code: enrolCode });
    expect(confirm.status).toBe(200);
    expect(confirm.body.data.recoveryCodes.length).toBeGreaterThan(0);
    expect((await ctx.api.post('/api/v1/auth/mfa/email/setup').set(a.auth)).status).toBe(409);

    // login without a code: 401, a code is mailed
    const noCode = await ctx.api.post('/api/v1/auth/login').send({ email: a.email, password: STRONG_PASSWORD });
    expect(noCode.status).toBe(401);
    expect(noCode.body.errorMessage.map((e: { issue?: string }) => e.issue)).toContain('email_otp');
    const loginCode = sixDigits.exec(ctx.mail.last(a.email)!.text)![1]!;

    const wrong = await ctx.api.post('/api/v1/auth/login').send({ email: a.email, password: STRONG_PASSWORD, mfaCode: loginCode === '111111' ? '222222' : '111111' });
    expect(wrong.status).toBe(401);
    const ok = await ctx.api.post('/api/v1/auth/login').send({ email: a.email, password: STRONG_PASSWORD, mfaCode: loginCode });
    expect(ok.status).toBe(200);
    // a code is single use
    const replay = await ctx.api.post('/api/v1/auth/login').send({ email: a.email, password: STRONG_PASSWORD, mfaCode: loginCode });
    expect(replay.status).toBe(401);
  });
});
