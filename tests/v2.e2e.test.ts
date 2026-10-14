import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { getCtx, createActor, createPlatformAdmin, loginActor, uniq, tokenFromMail, STRONG_PASSWORD, type Actor, type TestCtx } from './helpers/app.js';
import { addMember, flush, ROLE } from './helpers/members.js';
import { withPlatformScope } from '../src/platform/scope.js';
import { publishDueContent } from '../src/modules/cms/routes.js';
import { remindExpiringDocuments } from '../src/modules/documents/routes.js';
import { runBilling } from '../src/modules/billing/routes.js';
import { runDueSchedules } from '../src/modules/reporting/routes.js';
import { verifySignature, MAX_ATTEMPTS } from '../src/modules/integrations/routes.js';
import { cleanHtml } from '../src/modules/cms/routes.js';
import { MockProvider } from '../src/platform/payment-provider.js';
import { assertSafeOutboundUrl } from '../src/platform/ssrf.js';

let ctx: TestCtx;
let admin: Actor;
beforeAll(async () => {
  ctx = await getCtx();
  admin = await createActor(ctx);
});
afterAll(async () => {
  await ctx.close();
});

const buf = (s: string) => Buffer.from(s);
const today = () => new Date().toISOString().slice(0, 10);

describe('CRM + client portal', () => {
  it('detects duplicates, converts leads once, builds client history', async () => {
    const email = `${uniq('lead')}@example.test`;
    const l = await ctx.api.post('/api/v1/leads').set(admin.auth).send({ name: 'Ada Lead', email, company: `Acme ${uniq()}` });
    expect(l.status).toBe(201);
    expect((await ctx.api.post('/api/v1/leads').set(admin.auth).send({ name: 'Dup', email })).status).toBe(409);
    const conv = await ctx.api.post(`/api/v1/leads/${l.body.data.id}/convert`).set(admin.auth).send({});
    expect(conv.status).toBe(200);
    expect((await ctx.api.post(`/api/v1/leads/${l.body.data.id}/convert`).set(admin.auth).send({})).status).toBe(409);
    await ctx.api.post(`/api/v1/clients/${conv.body.data.customerId}/activities`).set(admin.auth).send({ kind: 'call', summary: 'Intro call' });
    const hist = await ctx.api.get(`/api/v1/clients/${conv.body.data.customerId}/history`).set(admin.auth);
    expect(hist.body.data.timeline.map((t: { type: string }) => t.type)).toEqual(expect.arrayContaining(['call', 'converted']));
    expect((await ctx.api.post('/api/v1/follow-ups').set(admin.auth).send({ title: 'x', dueAt: new Date().toISOString() })).status).toBe(422);
  });

  it('portal accounts live in a separate realm and only see their own client data', async () => {
    const orgInfo = await ctx.api.get('/api/v1/organization').set(admin.auth);
    const code = orgInfo.body.data.code as string;
    const mkClient = async (name: string) => (await ctx.api.post('/api/v1/billing-customers').set(admin.auth).send({ name: `${name} ${uniq()}` })).body.data.id as string;
    const c1 = await mkClient('Client One');
    const c2 = await mkClient('Client Two');
    const inv = async (customerId: string) => {
      const d = await ctx.api.post('/api/v1/invoices').set(admin.auth).send({ customerId, lines: [{ description: 'Work', quantity: '1', unitPrice: '10' }] });
      await ctx.api.post(`/api/v1/invoices/${d.body.data.id}/send`).set(admin.auth).set('Idempotency-Key', randomUUID());
      return d.body.data.id as string;
    };
    const i1 = await inv(c1);
    const i2 = await inv(c2);
    const email = `${uniq('portal')}@example.test`;
    expect((await ctx.api.post(`/api/v1/clients/${c1}/portal-accounts`).set(admin.auth).send({ email, name: 'Portal One' })).status).toBe(201);
    const pw = 'Portal-Passw0rd-123';
    expect((await ctx.api.post('/api/v1/portal/auth/set-password').send({ token: tokenFromMail(ctx.mail, email), password: pw })).status).toBe(200);
    const login = await ctx.api.post('/api/v1/portal/auth/login').send({ organizationCode: code, email, password: pw });
    expect(login.status).toBe(200);
    const tok = { Authorization: `Bearer ${login.body.data.accessToken}` };
    const mine = await ctx.api.get('/api/v1/portal/me/invoices').set(tok);
    const ids = mine.body.data.map((x: { id: string }) => x.id);
    expect(ids).toContain(i1);
    expect(ids).not.toContain(i2);
    // realms do not cross
    expect((await ctx.api.get('/api/v1/departments').set(tok)).status).toBe(401);
    expect((await ctx.api.get('/api/v1/portal/me/invoices').set(admin.auth)).status).toBe(401);
    // lockout
    for (let i = 0; i < 5; i++) await ctx.api.post('/api/v1/portal/auth/login').send({ organizationCode: code, email, password: 'wrong-Password-1!' });
    expect((await ctx.api.post('/api/v1/portal/auth/login').send({ organizationCode: code, email, password: pw })).status).toBe(401);
  });
});

describe('documents', () => {
  it('versions files, enforces ACL on top of RBAC, serves only clean files, audits downloads', async () => {
    const member = await addMember(ctx, admin, ROLE.member);
    const other = await addMember(ctx, admin, ROLE.member);
    const up = await ctx.api.post('/api/v1/documents').set(member.auth).field('title', `Policy ${uniq()}`).field('description', 'handbook')
      .attach('file', buf('v1 content'), { filename: 'policy.txt', contentType: 'text/plain' });
    expect(up.status).toBe(201);
    const id = up.body.data.id;
    const v2 = await ctx.api.post(`/api/v1/documents/${id}/versions`).set(member.auth).field('note', 'rev').attach('file', buf('v2 content'), { filename: 'policy-v2.txt', contentType: 'text/plain' });
    expect(v2.body.data.version).toBe(2);
    await flush(ctx);
    const early = await ctx.api.get(`/api/v1/documents/${id}`).set(other.auth);
    expect(early.status).toBe(200); // no ACL yet: org RBAC governs
    expect((await ctx.api.put(`/api/v1/documents/${id}/acl`).set(member.auth).send({ entries: [{ principalType: 'user', principalId: member.userId, permission: 'manage' }] })).status).toBe(200);
    expect((await ctx.api.get(`/api/v1/documents/${id}`).set(other.auth)).status).toBe(404);
    const list = await ctx.api.get('/api/v1/documents').set(other.auth);
    expect(list.body.data.map((d: { id: string }) => d.id)).not.toContain(id);
    expect((await ctx.api.get(`/api/v1/documents/${id}`).set(admin.auth)).status).toBe(200); // documents:manage_all
    // the viewer-level ACL entry grants read but not write
    await ctx.api.put(`/api/v1/documents/${id}/acl`).set(member.auth).send({ entries: [
      { principalType: 'user', principalId: member.userId, permission: 'manage' }, { principalType: 'user', principalId: other.userId, permission: 'view' }] });
    expect((await ctx.api.get(`/api/v1/documents/${id}`).set(other.auth)).status).toBe(200);
    expect((await ctx.api.patch(`/api/v1/documents/${id}`).set(other.auth).send({ title: 'Hijacked' })).status).toBe(403);
    // downloads: signed, short-lived, authorized at request time and audited
    const link = await ctx.api.get(`/api/v1/documents/${id}/download-link`).set(other.auth);
    expect(link.status).toBe(200);
    const dl = await ctx.api.get(link.body.data.url);
    expect(dl.status).toBe(200);
    expect(dl.text).toBe('v2 content');
    const old = await ctx.api.get(`/api/v1/documents/${id}/download-link`).query({ version: 1 }).set(other.auth);
    expect((await ctx.api.get(old.body.data.url)).text).toBe('v1 content');
    const trail = await ctx.api.get('/api/v1/audit-events').set(admin.auth).query({ resourceId: id });
    expect(trail.body.data.map((e: { action: string }) => e.action)).toEqual(expect.arrayContaining(['document.created', 'document.version_added', 'document.acl_changed']));
  });

  it('validates metadata types and sends one expiry reminder', async () => {
    const m = await addMember(ctx, admin, ROLE.member);
    const soon = new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 10);
    const up = await ctx.api.post('/api/v1/documents').set(m.auth).field('title', `Contract ${uniq()}`).field('expiresAt', soon)
      .attach('file', buf('contract'), { filename: 'c.txt', contentType: 'text/plain' });
    const id = up.body.data.id;
    const bad = await ctx.api.put(`/api/v1/documents/${id}/metadata`).set(m.auth).send({ items: [{ key: 'amount', type: 'number', value: 'abc' }] });
    expect(bad.status).toBe(422);
    const ok = await ctx.api.put(`/api/v1/documents/${id}/metadata`).set(m.auth).send({ items: [{ key: 'amount', type: 'number', value: '1200' }, { key: 'signed', type: 'boolean', value: 'true' }] });
    expect(ok.status).toBe(200);
    const found = await ctx.api.get('/api/v1/documents').set(m.auth).query({ q: '1200' });
    expect(found.body.data.map((d: { id: string }) => d.id)).toContain(id);
    expect(await remindExpiringDocuments(ctx.svc)).toBeGreaterThanOrEqual(1);
    expect(await remindExpiringDocuments(ctx.svc)).toBe(0);
    await flush(ctx);
    const notes = await ctx.api.get('/api/v1/notifications').set(m.auth);
    expect(notes.body.data.some((n: { type: string }) => n.type === 'document.expiring')).toBe(true);
  });

  it('rejects dangerous or mismatched uploads', async () => {
    const r = await ctx.api.post('/api/v1/documents').set(admin.auth).field('title', 'Bad').attach('file', buf('<?php system($_GET[1]); ?>'), { filename: 'shell.php', contentType: 'application/x-php' });
    expect(r.status).toBe(422);
  });
});

void [loginActor, STRONG_PASSWORD, createPlatformAdmin, withPlatformScope, publishDueContent, runBilling, runDueSchedules, verifySignature, MAX_ATTEMPTS, cleanHtml, MockProvider, assertSafeOutboundUrl, today];
