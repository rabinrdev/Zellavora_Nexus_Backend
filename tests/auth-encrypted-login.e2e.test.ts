import { createCipheriv } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createActor, getCtx, STRONG_PASSWORD, type TestCtx } from './helpers/app.js';

let ctx: TestCtx;
beforeAll(async () => { ctx = await getCtx(); });
afterAll(async () => { await ctx.close(); });

// same result as CryptoJS.AES.encrypt(value, Hex.parse(key), { iv: Hex.parse(iv), CBC, Pkcs7 }).toString()
const enc = (tokenkeys: string[], value: string) => {
  const [key, iv] = tokenkeys as [string, string];
  const c = createCipheriv('aes-256-cbc', Buffer.from(key, 'hex'), Buffer.from(iv, 'hex'));
  return Buffer.concat([c.update(value, 'utf8'), c.final()]).toString('base64');
};
const getToken = async () => (await ctx.api.get('/api/v1/auth/gettoken')).body as string[];

describe('login with encrypted fields (single /auth/login)', () => {
  it('gettoken returns [key, iv] and login accepts the AuthenticateUser shape', async () => {
    const a = await createActor(ctx, { kind: 'individual' });
    const tokenkeys = await getToken();
    expect(tokenkeys).toHaveLength(2);
    const r = await ctx.api.post('/api/v1/auth/login')
      .send({ userLoginId: enc(tokenkeys, a.email), password: enc(tokenkeys, STRONG_PASSWORD), tokenkeys });
    expect(r.status).toBe(200);
    expect(r.body.data.accessToken).toBeTruthy();
  });

  it('rejects fields encrypted with another token and forged tokenkeys', async () => {
    const t = await getToken();
    const other = await getToken();
    const bad = await ctx.api.post('/api/v1/auth/login')
      .send({ userLoginId: enc(other, 'x@example.test'), password: enc(other, 'x'), tokenkeys: t });
    expect(bad.status).toBe(422);
    const forged = [(t[0]![0] === 'a' ? 'b' : 'a') + t[0]!.slice(1), t[1]!];
    const r = await ctx.api.post('/api/v1/auth/login')
      .send({ userLoginId: enc(forged, 'x@example.test'), password: enc(forged, 'x'), tokenkeys: forged });
    expect(r.status).toBe(422);
  });

  it('wrong encrypted password is a 401 like the plain login', async () => {
    const a = await createActor(ctx, { kind: 'individual' });
    const t = await getToken();
    const r = await ctx.api.post('/api/v1/auth/login')
      .send({ userLoginId: enc(t, a.email), password: enc(t, 'Wrong-Password-1!'), tokenkeys: t });
    expect(r.status).toBe(401);
  });

  it('plain email/password still works', async () => {
    const a = await createActor(ctx, { kind: 'individual' });
    const r = await ctx.api.post('/api/v1/auth/login').send({ email: a.email, password: STRONG_PASSWORD });
    expect(r.status).toBe(200);
  });
});
