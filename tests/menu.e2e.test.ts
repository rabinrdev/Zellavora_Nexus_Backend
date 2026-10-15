import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getCtx, STRONG_PASSWORD, uniq, type TestCtx } from './helpers/app.js';
import { withPlatformScope } from '../src/platform/scope.js';
import { newId } from '../src/platform/crypto.js';
import { hashPassword } from '../src/platform/auth/password.js';

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await getCtx();
});
afterAll(async () => {
  await ctx.close();
});

describe('GET /me/menu', () => {
  it('serves a platform administrator who belongs to no organization', async () => {
    const email = `platform-${uniq()}@example.test`;
    const hash = await hashPassword(STRONG_PASSWORD);
    await withPlatformScope(ctx.svc.db, 'test', (t) =>
      t('users').insert({
        id: newId(), email, name: 'Platform Admin', password_hash: hash,
        password_changed_at: new Date(), email_verified_at: new Date(), is_platform_admin: true,
      }),
    );
    const login = await ctx.api.post('/api/v1/auth/login').send({ email, password: STRONG_PASSWORD });
    expect(login.status).toBe(200);
    const auth = { Authorization: `Bearer ${login.body.data.accessToken}` };

    const res = await ctx.api.get('/api/v1/me/menu').set(auth);
    expect(res.status).toBe(200);
    const keys: string[] = res.body.data.menu.map((n: { key: string }) => n.key);
    expect(keys).toContain('platform');
  });
});
