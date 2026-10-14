import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCtx, createActor, loginActor, tokenFromMail, currentTotp, STRONG_PASSWORD, uniq, type Actor, type TestCtx } from './helpers/app.js';
import { addMember, createEmptyRole, ROLE } from './helpers/members.js';
import { evaluate } from '../src/platform/jsonlogic.js';
import { LocalDiskStorage, MemoryStorage } from '../src/platform/storage.js';
import { MemoryMailProvider } from '../src/platform/mail.js';
import { ManualProvider, MockProvider, providerFor } from '../src/platform/payment-provider.js';
import { InlineJobQueue } from '../src/platform/jobs.js';
import { paginate } from '../src/platform/pagination.js';
import { AppError } from '../src/platform/errors.js';

let ctx: TestCtx;
let admin: Actor;
beforeAll(async () => {
  ctx = await getCtx();
  admin = await createActor(ctx);
});
afterAll(async () => {
  await ctx.close();
});

describe('IAM: roles, groups, reviews, changes', () => {
  it('manages custom roles end to end with matrix and effective access', async () => {
    const key = `analyst_${uniq().replace(/-/g, '_')}`;
    const role = await ctx.api.post('/api/v1/roles').set(admin.auth).send({ key, name: 'Analyst', description: 'reads', permissions: ['departments:read'] });
    expect(role.status).toBe(201);
    const rid = role.body.data.id;
    expect((await ctx.api.post('/api/v1/roles').set(admin.auth).send({ key, name: 'Dup', permissions: [] })).status).toBe(409);
    expect((await ctx.api.post('/api/v1/roles').set(admin.auth).send({ key: `x_${uniq().replace(/-/g, '_')}`, name: 'Bad', permissions: ['nope:nope'] })).status).toBe(422);
    expect((await ctx.api.patch(`/api/v1/roles/${rid}`).set(admin.auth).send({ name: 'Senior Analyst' })).status).toBe(200);
    expect((await ctx.api.put(`/api/v1/roles/${rid}/permissions`).set(admin.auth).send({ permissions: ['departments:read', 'locations:read'] })).status).toBe(200);
    const detail = await ctx.api.get(`/api/v1/roles/${rid}`).set(admin.auth);
    expect(detail.body.data.permissions).toEqual(['departments:read', 'locations:read']);
    const m = await addMember(ctx, admin, rid);
    expect((await ctx.api.get('/api/v1/locations').set(m.auth)).status).toBe(200);
    expect((await ctx.api.get('/api/v1/roles').set(m.auth)).status).toBe(403);
    // changing role permissions revokes outstanding tokens immediately
    await ctx.api.put(`/api/v1/roles/${rid}/permissions`).set(admin.auth).send({ permissions: ['departments:read'] });
    expect((await ctx.api.get('/api/v1/locations').set(m.auth)).status).toBe(401);
    const eff = await ctx.api.get(`/api/v1/iam/users/${m.userId}/effective-access`).set(admin.auth);
    expect(eff.body.data.permissions).toEqual(['departments:read']);
    const matrix = await ctx.api.get('/api/v1/iam/permission-matrix').set(admin.auth);
    expect(matrix.body.data.roles.some((r: { key: string }) => r.key === key)).toBe(true);
    expect((await ctx.api.delete(`/api/v1/roles/${rid}`).set(admin.auth)).status).toBe(409); // still assigned
    const mem = await ctx.api.get(`/api/v1/users/${m.userId}`).set(admin.auth);
    expect(mem.body.data.roles[0].key).toBe(key);
    expect((await ctx.api.delete(`/api/v1/users/${m.userId}/roles/${rid}`).set(admin.auth)).status).toBe(204);
    expect((await ctx.api.delete(`/api/v1/roles/${rid}`).set(admin.auth)).status).toBe(204);
    const cat = await ctx.api.get('/api/v1/permissions').set(admin.auth);
    expect(cat.body.data.length).toBeGreaterThan(100);
  });

  it('groups grant roles to members and propagate immediately', async () => {
    const m = await addMember(ctx, admin, await createEmptyRole(ctx, admin));
    expect((await ctx.api.get('/api/v1/departments').set(m.auth)).status).toBe(403);
    const g = await ctx.api.post('/api/v1/groups').set(admin.auth).send({ name: `Ops ${uniq()}` });
    expect((await ctx.api.put(`/api/v1/groups/${g.body.data.id}/roles`).set(admin.auth).send({ roleIds: [ROLE.viewer] })).status).toBe(200);
    expect((await ctx.api.post(`/api/v1/groups/${g.body.data.id}/members`).set(admin.auth).send({ userId: m.userId })).status).toBe(201);
    expect((await ctx.api.post(`/api/v1/groups/${g.body.data.id}/members`).set(admin.auth).send({ userId: m.userId })).status).toBe(409);
    expect((await ctx.api.get('/api/v1/departments').set(m.auth)).status).toBe(401); // pv moved
    const again = await loginActor(ctx, m.email);
    expect((await ctx.api.get('/api/v1/departments').set(again.auth)).status).toBe(200);
    expect((await ctx.api.delete(`/api/v1/groups/${g.body.data.id}/members/${m.userId}`).set(admin.auth)).status).toBe(204);
    expect((await ctx.api.get('/api/v1/departments').set(again.auth)).status).toBe(401);
  });

  it('access reviews revoke on decision and complete', async () => {
    const a = await createActor(ctx);
    const m = await addMember(ctx, a, ROLE.manager);
    const rev = await ctx.api.post('/api/v1/iam/access-reviews').set(a.auth).send({ name: 'Q1 review' });
    expect(rev.status).toBe(201);
    const det = await ctx.api.get(`/api/v1/iam/access-reviews/${rev.body.data.id}`).set(a.auth);
    const items = det.body.data.items as { id: string; subjectUserId: string; roleId: string }[];
    for (const it of items) {
      const decision = it.subjectUserId === m.userId ? 'revoke' : 'keep';
      expect((await ctx.api.post(`/api/v1/iam/access-reviews/${rev.body.data.id}/items/${it.id}/decision`).set(a.auth).send({ decision })).status).toBe(200);
    }
    expect((await ctx.api.post(`/api/v1/iam/access-reviews/${rev.body.data.id}/items/${items[0]!.id}/decision`).set(a.auth).send({ decision: 'keep' })).status).toBe(409);
    const after = await ctx.api.get(`/api/v1/iam/access-reviews/${rev.body.data.id}`).set(a.auth);
    expect(after.body.data.status).toBe('completed');
    const hist = await ctx.api.get('/api/v1/iam/access-history').set(a.auth);
    expect(hist.body.data.some((h: { change: string }) => h.change === 'revoked')).toBe(true);
  });

  it('a second admin approves a privileged change, which is then applied', async () => {
    const a = await createActor(ctx);
    const second = await addMember(ctx, a, ROLE.org_admin);
    await ctx.api.patch('/api/v1/settings/organization').set(a.auth).send({ 'iam.permission_change_approval': true });
    const target = await addMember(ctx, a);
    const pending = await ctx.api.post(`/api/v1/users/${target.userId}/roles`).set(a.auth).send({ roleId: ROLE.org_admin });
    expect(pending.status).toBe(202);
    const approverToken = await loginActor(ctx, second.email);
    const list = await ctx.api.get('/api/v1/iam/permission-change-requests').set(approverToken.auth);
    expect(list.body.data.length).toBeGreaterThan(0);
    const ok = await ctx.api.post(`/api/v1/iam/permission-change-requests/${pending.body.data.requestId}/approve`).set(approverToken.auth);
    expect(ok.status).toBe(200);
    expect(ok.body.data.status).toBe('applied');
    const eff = await ctx.api.get(`/api/v1/iam/users/${target.userId}/effective-access`).set(a.auth);
    expect(eff.body.data.directRoles.map((r: { key: string }) => r.key)).toContain('org_admin');
    const rej = await ctx.api.post(`/api/v1/iam/permission-change-requests/${pending.body.data.requestId}/reject`).set(approverToken.auth);
    expect(rej.status).toBe(409);
  });
});

describe('organizations', () => {
  it('invitations: list, resend, revoke, expiry and single use', async () => {
    const email = `${uniq('inv')}@example.test`;
    const inv = await ctx.api.post('/api/v1/invitations').set(admin.auth).send({ email });
    const list = await ctx.api.get('/api/v1/invitations').set(admin.auth).query({ 'filter[status]': 'pending' });
    expect(list.body.data.some((i: { id: string }) => i.id === inv.body.data.id)).toBe(true);
    const first = tokenFromMail(ctx.mail, email);
    expect((await ctx.api.post(`/api/v1/invitations/${inv.body.data.id}/resend`).set(admin.auth)).status).toBe(200);
    const second = tokenFromMail(ctx.mail, email);
    expect(second).not.toBe(first);
    expect((await ctx.api.post('/api/v1/auth/invitations/accept').send({ token: first, name: 'N', password: STRONG_PASSWORD })).status).toBe(422); // old token dead
    expect((await ctx.api.post(`/api/v1/invitations/${inv.body.data.id}/revoke`).set(admin.auth)).status).toBe(200);
    expect((await ctx.api.post('/api/v1/auth/invitations/accept').send({ token: second, name: 'N', password: STRONG_PASSWORD })).status).toBe(422);
    const inv2 = await ctx.api.post('/api/v1/invitations').set(admin.auth).send({ email: `${uniq('e')}@example.test` });
    await ctx.svc.db.raw('select 1');
    const { withPlatformScope } = await import('../src/platform/scope.js');
    await withPlatformScope(ctx.svc.db, 'test', (t) => t('invitations').where({ id: inv2.body.data.id }).update({ expires_at: new Date(Date.now() - 1000) }));
    const tok = tokenFromMail(ctx.mail, inv2.body.data.email);
    expect((await ctx.api.post('/api/v1/auth/invitations/accept').send({ token: tok, name: 'N', password: STRONG_PASSWORD })).status).toBe(422);
  });

  it('an existing user accepts an invitation while signed in and can switch organizations', async () => {
    const owner = await createActor(ctx);
    const other = await createActor(ctx);
    const inv = await ctx.api.post('/api/v1/invitations').set(owner.auth).send({ email: other.email, roleId: ROLE.member });
    expect(inv.status).toBe(201);
    const token = tokenFromMail(ctx.mail, other.email);
    expect((await ctx.api.post('/api/v1/auth/invitations/accept').send({ token })).status).toBe(401); // must sign in as the invitee
    const fresh = await loginActor(ctx, other.email);
    const acc = await ctx.api.post('/api/v1/auth/invitations/accept').set(fresh.auth).send({ token });
    expect(acc.status).toBe(200);
    const relog = await loginActor(ctx, other.email);
    const mine = await ctx.api.get('/api/v1/me/organizations').set(relog.auth);
    expect(mine.body.data).toHaveLength(2);
    const target = mine.body.data.find((o: { id: string }) => o.id === owner.organizationId);
    const sw = await ctx.api.post('/api/v1/auth/switch-organization').set(relog.auth).send({ organizationId: target.id });
    expect(sw.status).toBe(200);
    const me = await ctx.api.get('/api/v1/auth/me').set({ Authorization: `Bearer ${sw.body.data.accessToken}` });
    expect(me.body.data.organizationId).toBe(owner.organizationId);
    // cannot switch into an organization without membership (looks like not found)
    const stranger = await createActor(ctx);
    expect((await ctx.api.post('/api/v1/auth/switch-organization').set(relog.auth).send({ organizationId: stranger.organizationId })).status).toBe(404);
    // login by organization code resolves the right tenant (F-002)
    const code = (await ctx.api.get('/api/v1/organization').set(owner.auth)).body.data.code;
    const byCode = await ctx.api.post('/api/v1/auth/login').send({ email: other.email, password: STRONG_PASSWORD, organizationCode: code });
    expect(byCode.body.data.organizationId).toBe(owner.organizationId);
    const wrong = await ctx.api.post('/api/v1/auth/login').send({ email: other.email, password: STRONG_PASSWORD, organizationCode: 'does-not-exist' });
    expect(wrong.status).toBe(401);
  });

  it('transfers ownership with password re-confirmation and recipient acceptance', async () => {
    const a = await createActor(ctx);
    const heir = await addMember(ctx, a, ROLE.manager);
    expect((await ctx.api.post('/api/v1/organization/transfer-ownership').set(a.auth).send({ newOwnerUserId: heir.userId, password: 'wrong-Password-1!' })).status).toBe(403);
    const t = await ctx.api.post('/api/v1/organization/transfer-ownership').set(a.auth).send({ newOwnerUserId: heir.userId, password: STRONG_PASSWORD });
    expect(t.status).toBe(201);
    expect((await ctx.api.post(`/api/v1/organization/transfer-ownership/${t.body.data.id}/accept`).set(a.auth)).status).toBe(404); // not the recipient
    const heirAuth = await loginActor(ctx, heir.email);
    const ok = await ctx.api.post(`/api/v1/organization/transfer-ownership/${t.body.data.id}/accept`).set(heirAuth.auth);
    expect(ok.status).toBe(200);
    const heirAgain = await loginActor(ctx, heir.email);
    const org = await ctx.api.get('/api/v1/organization').set(heirAgain.auth);
    expect(org.body.data.ownerUserId).toBe(heir.userId);
  });

  it('updates profile with optimistic concurrency, validates logos and defaults', async () => {
    const a = await createActor(ctx);
    const org = await ctx.api.get('/api/v1/organization').set(a.auth);
    const v = org.body.data.rowVersion;
    expect((await ctx.api.patch('/api/v1/organization').set(a.auth).send({ name: 'Renamed Co', rowVersion: v + 5 })).status).toBe(412);
    const ok = await ctx.api.patch('/api/v1/organization').set(a.auth).send({ name: 'Renamed Co', branding: { primaryColor: '#112233' }, rowVersion: v });
    expect(ok.status).toBe(200);
    expect((await ctx.api.patch('/api/v1/organization').set(a.auth).send({ logoFileId: '00000000-0000-7000-8000-0000000000aa' })).status).toBe(422);
    expect((await ctx.api.patch('/api/v1/organization/defaults').set(a.auth).send({ timezone: 'Mars/Olympus' })).status).toBe(422);
    expect((await ctx.api.patch('/api/v1/organization/defaults').set(a.auth).send({ timezone: 'Asia/Kolkata', currency: 'inr' })).body.data.currency).toBe('INR');
  });

  it('exports organization data asynchronously', async () => {
    const a = await createActor(ctx);
    const ex = await ctx.api.post('/api/v1/organization/data-export').set(a.auth).set('Idempotency-Key', uniq('k'));
    expect(ex.status).toBe(202);
    const { flush } = await import('./helpers/members.js');
    await flush(ctx);
    const st = await ctx.api.get(`/api/v1/exports/${ex.body.data.id}`).set(a.auth);
    expect(st.body.data.status).toBe('completed');
    const file = await ctx.api.get(st.body.data.downloadLink.url);
    expect(JSON.parse(file.text).some((s: { section: string }) => s.section === 'members')).toBe(true);
  });
});

describe('auth: sessions, MFA lifecycle, verification', () => {
  it('lists and revokes sessions; logout-all kills every session', async () => {
    const a = await createActor(ctx);
    const second = await loginActor(ctx, a.email);
    const list = await ctx.api.get('/api/v1/auth/sessions').set(a.auth);
    expect(list.body.data.length).toBeGreaterThanOrEqual(2);
    const other = list.body.data.find((s: { current: boolean }) => !s.current);
    expect((await ctx.api.delete(`/api/v1/auth/sessions/${other.id}`).set(a.auth)).status).toBe(204);
    expect((await ctx.api.get('/api/v1/auth/me').set(second.auth)).status).toBe(401);
    expect((await ctx.api.delete(`/api/v1/auth/sessions/${other.id}`).set(a.auth)).status).toBe(404);
    expect((await ctx.api.post('/api/v1/auth/logout-all').set(a.auth)).status).toBe(200);
    expect((await ctx.api.get('/api/v1/auth/me').set(a.auth)).status).toBe(401);
  });

  it('disables MFA with password + code and regenerates recovery codes', async () => {
    const a = await createActor(ctx);
    const setup = await ctx.api.post('/api/v1/auth/mfa/setup').set(a.auth);
    const secret = setup.body.data.secret as string;
    expect((await ctx.api.post('/api/v1/auth/mfa/confirm').set(a.auth).send({ code: '000000' })).status).toBe(422);
    const conf = await ctx.api.post('/api/v1/auth/mfa/confirm').set(a.auth).send({ code: currentTotp(secret) });
    expect(conf.body.data.recoveryCodes).toHaveLength(10);
    expect((await ctx.api.post('/api/v1/auth/mfa/setup').set(a.auth)).status).toBe(409);
    const ver = await ctx.api.post('/api/v1/auth/mfa/verify').set(a.auth).send({ code: currentTotp(secret) });
    expect(ver.body.data.verified).toBe(true);
    const regen = await ctx.api.post('/api/v1/auth/mfa/recovery-codes/regenerate').set(a.auth).send({ code: currentTotp(secret) });
    expect(regen.body.data.recoveryCodes).toHaveLength(10);
    // old recovery codes no longer work
    const old = await ctx.api.post('/api/v1/auth/login').send({ email: a.email, password: STRONG_PASSWORD, mfaCode: conf.body.data.recoveryCodes[0] });
    expect(old.status).toBe(401);
    expect((await ctx.api.post('/api/v1/auth/mfa/disable').set(a.auth).send({ password: 'wrong-Password-1!', code: currentTotp(secret) })).status).toBe(403);
    expect((await ctx.api.post('/api/v1/auth/mfa/disable').set(a.auth).send({ password: STRONG_PASSWORD, code: currentTotp(secret) })).status).toBe(200);
    expect((await ctx.api.post('/api/v1/auth/login').send({ email: a.email, password: STRONG_PASSWORD })).status).toBe(200);
  });

  it('requires a verified email and supports resending the verification', async () => {
    const email = `${uniq('unv')}@example.test`;
    await ctx.api.post('/api/v1/auth/register').send({ kind: 'individual', name: 'Un Verified', email, password: STRONG_PASSWORD });
    expect((await ctx.api.post('/api/v1/auth/login').send({ email, password: STRONG_PASSWORD })).status).toBe(401);
    const before = tokenFromMail(ctx.mail, email);
    await ctx.api.post('/api/v1/auth/resend-verification').send({ email });
    const after = tokenFromMail(ctx.mail, email);
    expect(after).not.toBe(before);
    expect((await ctx.api.post('/api/v1/auth/verify-email').send({ token: after })).status).toBe(200);
    expect((await ctx.api.post('/api/v1/auth/verify-email').send({ token: after })).status).toBe(422); // single use
    expect((await ctx.api.post('/api/v1/auth/login').send({ email, password: STRONG_PASSWORD })).status).toBe(200);
  });

  it('applies the organization security policy dynamically (password rules, lockout)', async () => {
    const a = await createActor(ctx);
    expect((await ctx.api.put('/api/v1/security/policy').set(a.auth).send({ session: { idleMinutes: 600, absoluteMinutes: 60 } })).status).toBe(422);
    expect((await ctx.api.put('/api/v1/security/policy').set(a.auth).send({ mfa: { requiredForRoles: ['org_admin'] } })).status).toBe(200);
    const login = await ctx.api.post('/api/v1/auth/login').send({ email: a.email, password: STRONG_PASSWORD });
    expect(login.body.data.mfaSetupRequired).toBe(true); // admins must enrol
    const pol = await ctx.api.get('/api/v1/security/policy').set({ Authorization: `Bearer ${login.body.data.accessToken}` });
    expect(pol.status).toBe(401); // pending MFA sessions cannot use normal endpoints
  });

  it('privacy requests: export package and erasure honour retention', async () => {
    const a = await createActor(ctx);
    const m = await addMember(ctx, a, ROLE.member);
    const req = await ctx.api.post('/api/v1/privacy-requests').set(a.auth).send({ kind: 'export', subjectUserId: m.userId });
    expect(req.status).toBe(201);
    const done = await ctx.api.post(`/api/v1/privacy-requests/${req.body.data.id}/process`).set(a.auth);
    expect(done.body.data.fileId).toBeTruthy();
    expect((await ctx.api.post(`/api/v1/privacy-requests/${req.body.data.id}/process`).set(a.auth)).status).toBe(409);
    const er = await ctx.api.post('/api/v1/privacy-requests').set(a.auth).send({ kind: 'erasure', subjectUserId: m.userId });
    const res = await ctx.api.post(`/api/v1/privacy-requests/${er.body.data.id}/process`).set(a.auth);
    expect(res.body.data.anonymized).toBe(true);
    const row = await ctx.svc.db('users').where({ id: m.userId }).first();
    expect(row.email).toContain('erased-');
    expect(row.password_hash).toBeNull();
    expect((await ctx.api.post('/api/v1/auth/login').send({ email: m.email, password: STRONG_PASSWORD })).status).toBe(401);
    const ownerErase = await ctx.api.post('/api/v1/privacy-requests').set(a.auth).send({ kind: 'erasure' });
    expect((await ctx.api.post(`/api/v1/privacy-requests/${ownerErase.body.data.id}/process`).set(a.auth)).status).toBe(409); // owner must transfer first
  });
});

describe('infrastructure units', () => {
  it('JSON logic covers arithmetic, conditionals and string ops', () => {
    expect(evaluate({ '+': [1, 2, { '*': [2, 3] }] }, {})).toBe(9);
    expect(evaluate({ if: [{ '<': [{ var: 'x' }, 5] }, 'low', { '<': [{ var: 'x' }, 10] }, 'mid', 'high'] }, { x: 7 })).toBe('mid');
    expect(evaluate({ cat: ['a', { var: 'b' }] }, { b: 'c' })).toBe('ac');
    expect(evaluate({ '<': [1, { var: 'v' }, 10] }, { v: 5 })).toBe(true);
    expect(evaluate({ in: ['ell', 'hello'] }, {})).toBe(true);
    expect(evaluate({ max: [1, 9, 3] }, {})).toBe(9);
    expect(evaluate({ or: [false, 0, 'x'] }, {})).toBe('x');
    expect(evaluate({ '!': [true] }, {})).toBe(false);
    expect(evaluate({ '%': [10, 3] }, {})).toBe(1);
    expect(evaluate({ var: ['missing', 'dflt'] }, {})).toBe('dflt');
    expect(() => evaluate({ a: 1, b: 2 }, {})).toThrow(/exactly one/);
    let deep: unknown = { var: 'x' };
    for (let i = 0; i < 30; i++) deep = { '!': [deep] };
    expect(() => evaluate(deep, {})).toThrow(/nested/);
  });

  it('storage drivers: local disk blocks traversal; memory works; mail and providers behave', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nexus-'));
    try {
      const s = new LocalDiskStorage(dir);
      await s.put('a/b.bin', Buffer.from('x'));
      expect((await s.get('a/b.bin')).toString()).toBe('x');
      expect(await s.exists('a/b.bin')).toBe(true);
      await s.delete('a/b.bin');
      expect(await s.exists('a/b.bin')).toBe(false);
      await expect(s.put('../escape', Buffer.from('x'))).rejects.toThrow(/Invalid storage key/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    const mem = new MemoryStorage();
    await mem.put('k', Buffer.from('v'));
    expect(await mem.exists('k')).toBe(true);
    await expect(mem.get('missing')).rejects.toThrow();
    const mail = new MemoryMailProvider();
    await mail.send({ to: 'a@example.test', subject: 's', text: 't' });
    expect(mail.last('a@example.test')?.subject).toBe('s');
    expect(await mail.ping()).toBe(true);
    expect((await new ManualProvider().charge({ amount: '1', currency: 'USD', reference: 'r', customerRef: 'c' })).status).toBe('pending');
    const mock = new MockProvider('s');
    expect((await mock.charge({ amount: '1', currency: 'USD', reference: 'r', customerRef: 'fail' })).status).toBe('failed');
    expect(providerFor('mock').name).toBe('mock');
    expect(() => providerFor('stripe')).toThrow();
  });

  it('inline job queue retries a bounded number of times then dead-letters, recording runs', async () => {
    const q = new InlineJobQueue(ctx.svc.db);
    let calls = 0;
    q.work('mail', async () => { calls++; throw new Error('boom'); });
    await q.enqueue('mail', { x: 1 });
    expect(calls).toBe(5);
    expect(q.deadLetter).toHaveLength(1);
    const { withPlatformScope } = await import('../src/platform/scope.js');
    const runs = await withPlatformScope(ctx.svc.db, 'test', (t) => t('job_runs').where({ queue: 'mail', status: 'dead_letter' }).count({ c: '*' }).first());
    expect(Number((runs as { c: string }).c)).toBeGreaterThan(0);
  });

  it('pagination rejects malformed cursors and unknown filters', async () => {
    const qb = ctx.svc.db('departments');
    await expect(paginate(qb, { limit: 5, cursor: 'not-base64-json' }, { sortable: { name: 'name' }, defaultSort: 'name' })).rejects.toBeInstanceOf(AppError);
    await expect(paginate(ctx.svc.db('departments'), { limit: 5, filter: { evil: 'x' } }, { sortable: { name: 'name' }, defaultSort: 'name' })).rejects.toBeInstanceOf(AppError);
  });
});
