import { createCipheriv } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createActor, getCtx, STRONG_PASSWORD, type TestCtx } from './helpers/app.js';

let ctx: TestCtx;
beforeAll(async () => { ctx = await getCtx(); });
afterAll(async () => { await ctx.close(); });

const encryptLike = (token: string[], payload: unknown) => {
  const [key, iv] = token as [string, string];
  // same result as CryptoJS.AES.encrypt(json, Base64.parse(key), { iv, CBC, Pkcs7 }).toString()
  const c = createCipheriv('aes-256-cbc', Buffer.from(key, 'base64'), Buffer.from(iv, 'base64'));
  return Buffer.concat([c.update(JSON.stringify(payload), 'utf8'), c.final()]).toString('base64');
};

describe('encrypted login', () => {
  it('gettoken → encrypt → login-encrypted returns a token bundle', async () => {
    const a = await createActor(ctx, { kind: 'individual' });
    const t = await ctx.api.get('/api/v1/auth/gettoken');
    expect(t.status).toBe(200);
    const token = t.body.data;
    const r = await ctx.api.post('/api/v1/auth/login-encrypted')
      .send({ token, data: encryptLike(token, { email: a.email, password: STRONG_PASSWORD }) });
    expect(r.status).toBe(200);
    expect(r.body.data.accessToken).toBeTruthy();
  });

  it('rejects a payload encrypted with the wrong key and a tampered token', async () => {
    const t = (await ctx.api.get('/api/v1/auth/gettoken')).body.data;
    const other = (await ctx.api.get('/api/v1/auth/gettoken')).body.data;
    const bad = await ctx.api.post('/api/v1/auth/login-encrypted')
      .send({ token: t, data: encryptLike(other, { email: 'x@example.test', password: 'x' }) });
    expect(bad.status).toBe(422);
    const tampered = await ctx.api.post('/api/v1/auth/login-encrypted')
      .send({ token: [t[0].slice(0, -2) + 'AA', t[1]], data: encryptLike(t, { email: 'x@example.test', password: 'x' }) });
    expect(tampered.status).toBe(422);
  });

  it('wrong password is a 401 like the plain login', async () => {
    const a = await createActor(ctx, { kind: 'individual' });
    const t = (await ctx.api.get('/api/v1/auth/gettoken')).body.data;
    const r = await ctx.api.post('/api/v1/auth/login-encrypted')
      .send({ token: t, data: encryptLike(t, { email: a.email, password: 'Wrong-Password-1!' }) });
    expect(r.status).toBe(401);
  });
});
