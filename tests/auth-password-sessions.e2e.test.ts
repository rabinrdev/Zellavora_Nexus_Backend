import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createActor, getCtx, STRONG_PASSWORD, type TestCtx } from './helpers/app.js';

let ctx: TestCtx;
beforeAll(async () => { ctx = await getCtx(); });
afterAll(async () => { await ctx.close(); });

const NEW_PASSWORD = 'Another-Strong-Pass-42!';

describe('change password, reset token validation and other-session revocation', () => {
  it('rejects a wrong current password and a reused password', async () => {
    const a = await createActor(ctx, { kind: 'individual' });
    const wrong = await ctx.api.post('/api/v1/auth/change-password').set(a.auth)
      .send({ currentPassword: 'Not-The-Password-1!', newPassword: NEW_PASSWORD });
    expect(wrong.status).toBe(422);
    const same = await ctx.api.post('/api/v1/auth/change-password').set(a.auth)
      .send({ currentPassword: STRONG_PASSWORD, newPassword: STRONG_PASSWORD });
    expect(same.status).toBe(422);
  });

  it('changes the password, keeps the caller signed in and revokes other sessions', async () => {
    const a = await createActor(ctx, { kind: 'individual' });
    const other = await ctx.api.post('/api/v1/auth/login').send({ email: a.email, password: STRONG_PASSWORD });
    expect(other.status).toBe(200);

    const r = await ctx.api.post('/api/v1/auth/change-password').set(a.auth)
      .send({ currentPassword: STRONG_PASSWORD, newPassword: NEW_PASSWORD });
    expect(r.status).toBe(200);
    expect(r.body.data.revokedSessions).toBeGreaterThanOrEqual(1);

    expect((await ctx.api.get('/api/v1/auth/me').set(a.auth)).status).toBe(200);
    const refresh = await ctx.api.post('/api/v1/auth/refresh').send({ refreshToken: other.body.data.refreshToken });
    expect(refresh.status).toBe(401);

    expect((await ctx.api.post('/api/v1/auth/login').send({ email: a.email, password: STRONG_PASSWORD })).status).toBe(401);
    expect((await ctx.api.post('/api/v1/auth/login').send({ email: a.email, password: NEW_PASSWORD })).status).toBe(200);
  });

  it('DELETE /auth/sessions revokes everything except the current session', async () => {
    const a = await createActor(ctx, { kind: 'individual' });
    await ctx.api.post('/api/v1/auth/login').send({ email: a.email, password: STRONG_PASSWORD });
    const r = await ctx.api.delete('/api/v1/auth/sessions').set(a.auth);
    expect(r.status).toBe(200);
    expect(r.body.data.revoked).toBeGreaterThanOrEqual(1);
    const list = await ctx.api.get('/api/v1/auth/sessions').set(a.auth);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].current).toBe(true);
  });

  it('reset-password/validate answers false for an unknown token and needs no auth', async () => {
    const r = await ctx.api.post('/api/v1/auth/reset-password/validate').send({ token: 'x'.repeat(43) });
    expect(r.status).toBe(200);
    expect(r.body.data.valid).toBe(false);
  });
});
