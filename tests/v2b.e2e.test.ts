import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { getCtx, createActor, createPlatformAdmin, loginActor, uniq, type Actor, type TestCtx } from './helpers/app.js';
import { addMember, flush, ROLE } from './helpers/members.js';
import { withPlatformScope } from '../src/platform/scope.js';
import { publishDueContent, cleanHtml } from '../src/modules/cms/routes.js';
import { runBilling } from '../src/modules/billing/routes.js';
import { runDueSchedules } from '../src/modules/reporting/routes.js';
import { verifySignature, MAX_ATTEMPTS } from '../src/modules/integrations/routes.js';
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

const q = <T>(fn: (t: import('../src/platform/scope.js').Trx) => Promise<T>) => withPlatformScope(ctx.svc.db, 'test', fn);
const slugOf = async (a: Actor) => (await ctx.api.get('/api/v1/organization').set(a.auth)).body.data.slug as string;

describe('CMS, page builder and themes', () => {
  it('sanitizes rich text, keeps drafts private, and serves only the published version', async () => {
    expect(cleanHtml('<p onclick="x()">Hi</p><script>alert(1)</script><a href="javascript:evil()">l</a>')).toBe('<p>Hi</p><a rel="noopener noreferrer">l</a>');
    const a = await createActor(ctx);
    const slug = await slugOf(a);
    const p = await ctx.api.post('/api/v1/pages').set(a.auth).send({ title: 'About us', body: '<p>v1</p><script>x</script>' });
    expect(p.status).toBe(201);
    expect(p.body.data.body).toBe('<p>v1</p>');
    const id = p.body.data.id;
    expect((await ctx.api.get(`/api/v1/public/${slug}/pages/about-us`)).status).toBe(404); // draft not exposed
    expect((await ctx.api.post(`/api/v1/pages/${id}/publish`).set(a.auth)).status).toBe(200);
    const pub = await ctx.api.get(`/api/v1/public/${slug}/pages/about-us`);
    expect(pub.status).toBe(200);
    expect(pub.body.data.body).toBe('<p>v1</p>');
    // edits do not go live until published again
    await ctx.api.patch(`/api/v1/pages/${id}`).set(a.auth).send({ body: '<p>v2</p>' });
    expect((await ctx.api.get(`/api/v1/public/${slug}/pages/about-us`)).body.data.body).toBe('<p>v1</p>');
    // preview link shows the draft; rollback creates a new version
    const pv = await ctx.api.post(`/api/v1/pages/${id}/preview-link`).set(a.auth);
    expect((await ctx.api.get(pv.body.data.url)).body.data.body).toBe('<p>v2</p>');
    const rb = await ctx.api.post(`/api/v1/pages/${id}/versions/1/rollback`).set(a.auth);
    expect(rb.status).toBe(201);
    expect(rb.body.data.version).toBe(3);
    const versions = await ctx.api.get(`/api/v1/pages/${id}/versions`).set(a.auth);
    expect(versions.body.data.map((v: { version: number }) => v.version)).toEqual([3, 2, 1]);
    // unpublished content disappears
    await ctx.api.post(`/api/v1/pages/${id}/unpublish`).set(a.auth);
    expect((await ctx.api.get(`/api/v1/public/${slug}/pages/about-us`)).status).toBe(404);
    expect((await ctx.api.get(pv.body.data.url.replace(/.$/, 'x'))).status).toBe(404); // tampered token
    const seo = await ctx.api.get(`/api/v1/pages/${id}/seo-preview`).set(a.auth);
    expect(seo.body.data.warnings).toContain('Missing meta description');
  });

  it('separates edit and publish permissions; schedules publication via job', async () => {
    const a = await createActor(ctx);
    const slug = await slugOf(a);
    const editor = await addMember(ctx, a, ROLE.member);
    const p = await ctx.api.post('/api/v1/pages').set(editor.auth).send({ title: 'Sched', body: '<p>soon</p>' });
    expect(p.status).toBe(201);
    expect((await ctx.api.post(`/api/v1/pages/${p.body.data.id}/publish`).set(editor.auth)).status).toBe(403);
    const when = new Date(Date.now() + 3600_000).toISOString();
    expect((await ctx.api.post(`/api/v1/pages/${p.body.data.id}/schedule`).set(a.auth).send({ publishAt: when })).status).toBe(200);
    expect((await ctx.api.post(`/api/v1/pages/${p.body.data.id}/schedule`).set(a.auth).send({ publishAt: new Date(Date.now() - 1000).toISOString() })).status).toBe(422);
    expect((await ctx.api.get(`/api/v1/public/${slug}/pages/sched`)).status).toBe(404);
    await q((t) => t('content_items').where({ id: p.body.data.id }).update({ publish_at: new Date(Date.now() - 1000) }));
    expect(await publishDueContent(ctx.svc)).toBeGreaterThanOrEqual(1);
    expect(await publishDueContent(ctx.svc)).toBe(0);
    expect((await ctx.api.get(`/api/v1/public/${slug}/pages/sched`)).status).toBe(200);
  });

  it('page builder validates block props, persists ordering, snapshots on publish', async () => {
    const a = await createActor(ctx);
    const slug = await slugOf(a);
    const p = await ctx.api.post('/api/v1/pages').set(a.auth).send({ title: 'Landing' });
    const bad = await ctx.api.put(`/api/v1/pages/${p.body.data.id}/blocks`).set(a.auth).send({ blocks: [{ type: 'cta', props: { label: 'Go', url: 'javascript:alert(1)' } }] });
    expect(bad.status).toBe(422);
    const ok = await ctx.api.put(`/api/v1/pages/${p.body.data.id}/blocks`).set(a.auth).send({ blocks: [
      { type: 'hero', props: { heading: 'Welcome' } }, { type: 'text', props: { html: '<p>Hi<script>x</script></p>' } }, { type: 'cta', props: { label: 'Go', url: '/signup' } }] });
    expect(ok.status).toBe(200);
    const list = await ctx.api.get(`/api/v1/pages/${p.body.data.id}/blocks`).set(a.auth);
    const ids = list.body.data.map((b: { id: string }) => b.id);
    expect(list.body.data[1].props.html).toBe('<p>Hi</p>');
    expect((await ctx.api.put(`/api/v1/pages/${p.body.data.id}/blocks/order`).set(a.auth).send({ ids: [ids[2], ids[0], ids[1]] })).status).toBe(200);
    expect((await ctx.api.put(`/api/v1/pages/${p.body.data.id}/blocks/order`).set(a.auth).send({ ids: [ids[0]] })).status).toBe(422);
    await ctx.api.post(`/api/v1/pages/${p.body.data.id}/publish`).set(a.auth);
    const pub = await ctx.api.get(`/api/v1/public/${slug}/pages/landing`);
    expect(pub.body.data.blocks.map((b: { type: string }) => b.type)).toEqual(['cta', 'hero', 'text']);
  });

  it('allows one active theme and validates tokens', async () => {
    const a = await createActor(ctx);
    const slug = await slugOf(a);
    const tokens = { colors: { primary: '#112233', secondary: '#445566', background: '#ffffff', surface: '#f5f5f5', text: '#111111' }, typography: { headingFont: 'Inter', bodyFont: 'Roboto', baseSize: 16 } };
    expect((await ctx.api.post('/api/v1/themes').set(a.auth).send({ name: 'Bad', tokens: { ...tokens, colors: { ...tokens.colors, primary: 'red; background:url(x)' } } })).status).toBe(422);
    const t1 = await ctx.api.post('/api/v1/themes').set(a.auth).send({ name: 'One', tokens });
    const t2 = await ctx.api.post('/api/v1/themes').set(a.auth).send({ name: 'Two', tokens });
    await ctx.api.post(`/api/v1/themes/${t1.body.data.id}/activate`).set(a.auth);
    await ctx.api.post(`/api/v1/themes/${t2.body.data.id}/activate`).set(a.auth);
    const list = await ctx.api.get('/api/v1/themes').set(a.auth);
    expect(list.body.data.filter((t: { isActive: boolean }) => t.isActive)).toHaveLength(1);
    expect((await ctx.api.get(`/api/v1/public/${slug}/theme`)).body.data.name).toBe('Two');
    expect((await ctx.api.delete(`/api/v1/themes/${t2.body.data.id}`).set(a.auth)).status).toBe(409);
  });
});

describe('billing', () => {
  it('meters plans, enforces limits, and handles payment failure with dunning to suspension', async () => {
    const a = await createActor(ctx);
    const pa = await createPlatformAdmin(ctx);
    // free plan: max 3 projects
    expect((await ctx.api.put(`/api/v1/platform/tenants/${a.organizationId}/plan`).set(pa.auth).send({ planKey: 'free' })).status).toBe(200);
    for (let i = 0; i < 3; i++) expect((await ctx.api.post('/api/v1/projects').set(a.auth).send({ name: `P${i} ${uniq()}` })).status).toBe(201);
    const over = await ctx.api.post('/api/v1/projects').set(a.auth).send({ name: `P4 ${uniq()}` });
    expect(over.status).toBe(402);
    expect(over.body.error.code).toBe('PLAN_LIMIT_EXCEEDED');
    expect((await ctx.api.post('/api/v1/api-keys').set(a.auth).send({ name: 'ci-key', scopes: ['users:read'] })).status).toBe(402); // api_access not in free
    // upgrade: starts a trial, limits lift
    const sub = await ctx.api.post('/api/v1/subscriptions').set(a.auth).set('Idempotency-Key', randomUUID()).send({ planKey: 'pro', provider: 'mock', customerRef: 'cust_fail' });
    expect(sub.status).toBe(201);
    expect(sub.body.data.status).toBe('trialing');
    expect((await ctx.api.post('/api/v1/projects').set(a.auth).send({ name: `P5 ${uniq()}` })).status).toBe(201);
    // usage metering is idempotent per event id
    const ev = { metric: 'api_calls', quantity: 5, eventId: 'evt-1' };
    expect((await ctx.api.post('/api/v1/usage/events').set(a.auth).send(ev)).body.data.recorded).toBe(true);
    expect((await ctx.api.post('/api/v1/usage/events').set(a.auth).send(ev)).body.data.duplicate).toBe(true);
    expect((await ctx.api.get('/api/v1/usage').set(a.auth)).body.data.metrics[0].total).toBe('5.0000');
    // trial ends -> charge fails -> past_due
    await q((t) => t('subscriptions').where({ id: sub.body.data.id }).update({ current_period_end: new Date(Date.now() - 1000) }));
    expect((await runBilling(ctx.svc)).failed).toBeGreaterThanOrEqual(1);
    expect((await ctx.api.get('/api/v1/subscriptions/current').set(a.auth)).body.data.subscription.status).toBe('past_due');
    // restricted after 14 days: reads allowed, writes blocked
    await q((t) => t('subscriptions').where({ id: sub.body.data.id }).update({ past_due_since: new Date(Date.now() - 15 * 86400_000) }));
    await runBilling(ctx.svc);
    expect((await ctx.api.get('/api/v1/projects').set(a.auth)).status).toBe(200);
    expect((await ctx.api.post('/api/v1/projects').set(a.auth).send({ name: `P6 ${uniq()}` })).status).toBe(402);
    // provider webhook: signature required, idempotent, reactivates
    const inv = await q((t) => t('subscription_invoices').where({ subscription_id: sub.body.data.id, status: 'failed' }).first());
    const body = JSON.stringify({ id: `evt_${uniq('pay')}`, type: 'payment.succeeded', reference: inv.id });
    const prov = new MockProvider();
    expect((await ctx.api.post('/api/v1/billing/webhooks/mock').set('Content-Type', 'application/json').set('X-Signature', 'bad').send(body)).status).toBe(401);
    const good = await ctx.api.post('/api/v1/billing/webhooks/mock').set('Content-Type', 'application/json').set('X-Signature', prov.sign(body)).send(body);
    expect(good.status).toBe(200);
    expect(good.body.data.outcome).toBe('activated');
    const dup = await ctx.api.post('/api/v1/billing/webhooks/mock').set('Content-Type', 'application/json').set('X-Signature', prov.sign(body)).send(body);
    expect(dup.body.data.duplicate).toBe(true);
    expect((await ctx.api.post('/api/v1/projects').set(a.auth).send({ name: `P7 ${uniq()}` })).status).toBe(201);
  });

  it('suspends the tenant after the grace period', async () => {
    const a = await createActor(ctx);
    const sub = await ctx.api.post('/api/v1/subscriptions').set(a.auth).set('Idempotency-Key', randomUUID()).send({ planKey: 'pro', provider: 'mock', customerRef: 'cust_fail' });
    await q((t) => t('subscriptions').where({ id: sub.body.data.id }).update({ status: 'past_due', past_due_since: new Date(Date.now() - 31 * 86400_000), dunning_attempts: 4 }));
    expect((await runBilling(ctx.svc)).suspended).toBe(1);
    const r = await ctx.api.get('/api/v1/departments').set(a.auth);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('TENANT_SUSPENDED');
  });

  it('cancels at period end and expires by job', async () => {
    const a = await createActor(ctx);
    const sub = await ctx.api.post('/api/v1/subscriptions').set(a.auth).set('Idempotency-Key', randomUUID()).send({ planKey: 'pro', provider: 'manual' });
    expect((await ctx.api.post(`/api/v1/subscriptions/${sub.body.data.id}/cancel`).set(a.auth).send({})).body.data.cancelAtPeriodEnd).toBe(true);
    expect((await ctx.api.post(`/api/v1/subscriptions/${sub.body.data.id}/reactivate`).set(a.auth)).status).toBe(200);
    await ctx.api.post(`/api/v1/subscriptions/${sub.body.data.id}/cancel`).set(a.auth).send({});
    await q((t) => t('subscriptions').where({ id: sub.body.data.id }).update({ current_period_end: new Date(Date.now() - 1000) }));
    expect((await runBilling(ctx.svc)).expired).toBeGreaterThanOrEqual(1);
    expect((await ctx.api.get('/api/v1/subscriptions/current').set(a.auth)).body.data.subscription).toBeNull();
  });
});

describe('webhooks / integration hub', () => {
  it('blocks private destinations (SSRF) and unknown events', async () => {
    const r = await ctx.api.post('/api/v1/webhook-endpoints').set(admin.auth).send({ url: 'http://127.0.0.1/hook' });
    expect(r.status).toBe(422);
    const meta = await ctx.api.post('/api/v1/webhook-endpoints').set(admin.auth).send({ url: 'https://169.254.169.254/latest' });
    expect(meta.status).toBe(422);
    const bad = await ctx.api.post('/api/v1/webhook-endpoints').set(admin.auth).send({ url: 'https://hooks.example.test/x', eventTypes: ['nope.event'] });
    expect(bad.status).toBe(422);
    await expect(assertSafeOutboundUrl('https://u:p@hooks.example.test/', { requireHttps: true, resolver: async () => ['93.184.216.34'] })).rejects.toThrow();
    await expect(assertSafeOutboundUrl('https://x.example.test/', { requireHttps: true, resolver: async () => ['10.0.0.5'] })).rejects.toThrow(/address/);
    await expect(assertSafeOutboundUrl('https://x.example.test/', { requireHttps: true, resolver: async () => ['::ffff:127.0.0.1'] })).rejects.toThrow(/address/);
  });

  it('delivers signed events, retries with bounded backoff, supports retry/replay and secret rotation', async () => {
    const a = await createActor(ctx);
    const ep = await ctx.api.post('/api/v1/webhook-endpoints').set(a.auth).send({ url: `https://hooks.example.test/${uniq()}`, eventTypes: ['task.created'] });
    expect(ep.status).toBe(201);
    const secret = ep.body.data.secret as string;
    expect(secret.startsWith('whsec_')).toBe(true);
    expect(JSON.stringify((await ctx.api.get('/api/v1/webhook-endpoints').set(a.auth)).body)).not.toContain(secret);
    const proj = await ctx.api.post('/api/v1/projects').set(a.auth).send({ name: `WH ${uniq()}` });
    ctx.http.calls.length = 0;
    await ctx.api.post(`/api/v1/projects/${proj.body.data.id}/tasks`).set(a.auth).send({ title: 'Hooked' });
    await flush(ctx);
    const call = ctx.http.calls.find((c) => c.url.includes('hooks.example.test'));
    expect(call).toBeTruthy();
    expect(verifySignature(secret, call!.headers['x-nexus-signature']!, call!.body)).toBe(true);
    expect(verifySignature(secret, call!.headers['x-nexus-signature']!, `${call!.body} `)).toBe(false); // tampered body
    expect(verifySignature(secret, call!.headers['x-nexus-signature']!, call!.body, 300, Math.floor(Date.now() / 1000) + 3600)).toBe(false); // replayed late
    const hist = await ctx.api.get('/api/v1/webhook-deliveries').set(a.auth).query({ endpointId: ep.body.data.id });
    expect(hist.body.data[0].status).toBe('delivered');

    // failing receiver: bounded attempts then dead
    ctx.http.respond = () => 500;
    await ctx.api.post(`/api/v1/projects/${proj.body.data.id}/tasks`).set(a.auth).send({ title: 'Will fail' });
    await flush(ctx);
    const failed = (await ctx.api.get('/api/v1/webhook-deliveries').set(a.auth).query({ endpointId: ep.body.data.id, 'filter[status]': 'dead' })).body.data;
    expect(failed).toHaveLength(1);
    expect(failed[0].attempt).toBe(MAX_ATTEMPTS);
    ctx.http.respond = () => 200;
    expect((await ctx.api.post(`/api/v1/webhook-deliveries/${failed[0].id}/retry`).set(a.auth)).status).toBe(202);
    await flush(ctx);
    const after = (await ctx.api.get('/api/v1/webhook-deliveries').set(a.auth).query({ endpointId: ep.body.data.id, 'filter[status]': 'delivered' })).body.data;
    expect(after.length).toBe(2);
    // replay re-sends an old event
    const events = await ctx.api.get('/api/v1/webhook-events').set(a.auth);
    ctx.http.calls.length = 0;
    expect((await ctx.api.post(`/api/v1/webhook-events/${events.body.data[0].id}/replay`).set(a.auth).send({})).status).toBe(202);
    await flush(ctx);
    expect(ctx.http.calls.length).toBe(1);
    // rotation: new secret signs; old secret still verifies during the overlap
    const rot = await ctx.api.post(`/api/v1/webhook-endpoints/${ep.body.data.id}/rotate-secret`).set(a.auth).send({ overlapMinutes: 30 });
    ctx.http.calls.length = 0;
    await ctx.api.post(`/api/v1/webhook-events/${events.body.data[0].id}/replay`).set(a.auth).send({});
    await flush(ctx);
    const sig = ctx.http.calls[0]!.headers['x-nexus-signature']!;
    expect(sig.split(' ')).toHaveLength(2);
    expect(sig.split(' ').some((s) => verifySignature(rot.body.data.secret, s, ctx.http.calls[0]!.body))).toBe(true);
    expect(sig.split(' ').some((s) => verifySignature(secret, s, ctx.http.calls[0]!.body))).toBe(true);
  });

  it('stores integration secrets encrypted and never returns them', async () => {
    const put = await ctx.api.put('/api/v1/integrations/slack').set(admin.auth).send({ config: { token: 'xoxb-super-secret', channel: '#ops' } });
    expect(put.status).toBe(200);
    const raw = await q((t) => t('integration_configs').where({ provider: 'slack', organization_id: admin.organizationId }).first());
    expect(raw.config_encrypted).not.toContain('xoxb-super-secret');
    const list = await ctx.api.get('/api/v1/integrations').set(admin.auth);
    expect(JSON.stringify(list.body)).not.toContain('xoxb-super-secret');
  });
});

describe('advanced reporting', () => {
  it('compiles whitelisted definitions to parameterized SQL, rejects injection, and respects field permissions', async () => {
    const a = await createActor(ctx);
    for (const s of ['planning', 'active', 'active']) await ctx.api.post('/api/v1/projects').set(a.auth).send({ name: `R ${uniq()}`, status: s });
    const ds = await ctx.api.get('/api/v1/report-datasets').set(a.auth);
    expect(ds.body.data.map((d: { key: string }) => d.key)).toEqual(expect.arrayContaining(['projects', 'tasks']));
    const run = await ctx.api.post('/api/v1/reports/run').set(a.auth).send({
      dataset: 'projects', groupBy: ['status'], aggregations: [{ fn: 'count', as: 'n' }], orderBy: { field: 'status', direction: 'asc' },
    });
    expect(run.status).toBe(200);
    const rows = run.body.data.rows as { status: string; n: string }[];
    expect(Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]))).toEqual({ active: 2, planning: 1 });
    // injection attempts are just unknown fields
    for (const bad of ['name; DROP TABLE users', "status') OR 1=1 --", 'organization_id', '"; select 1']) {
      const r = await ctx.api.post('/api/v1/reports/run').set(a.auth).send({ dataset: 'projects', fields: [bad] });
      expect(r.status).toBe(422);
    }
    const inj = await ctx.api.post('/api/v1/reports/run').set(a.auth).send({ dataset: 'projects', fields: ['name'], filters: [{ field: 'name', op: 'eq', value: "x' OR '1'='1" }] });
    expect(inj.status).toBe(200);
    expect(inj.body.data.rows).toHaveLength(0);
    expect((await ctx.api.post('/api/v1/reports/run').set(a.auth).send({ dataset: 'users', fields: ['email'] })).status).toBe(422);
    // org scope
    const other = await createActor(ctx);
    const none = await ctx.api.post('/api/v1/reports/run').set(other.auth).send({ dataset: 'projects', fields: ['name'] });
    expect(none.body.data.rows).toHaveLength(0);
    // field-level permission
    const limited = await ctx.api.post('/api/v1/roles').set(a.auth).send({ key: `inv_only_${uniq().replace(/-/g, '_')}`, name: 'Invoice reader', permissions: ['invoices:read', 'reports:read', 'dashboard:read'] });
    const m = await addMember(ctx, a, limited.body.data.id);
    const allowed = await ctx.api.post('/api/v1/reports/run').set(m.auth).send({ dataset: 'invoices', fields: ['status'] });
    expect(allowed.status).toBe(200);
    const denied = await ctx.api.post('/api/v1/reports/run').set(m.auth).send({ dataset: 'invoices', groupBy: ['status'], aggregations: [{ fn: 'sum', field: 'amount_paid' }] });
    expect(denied.status).toBe(403);
    expect((await ctx.api.post('/api/v1/reports/run').set(m.auth).send({ dataset: 'projects', fields: ['name'] })).status).toBe(403);
  });

  it('saves reports, schedules them to member recipients only, and runs due schedules once', async () => {
    const a = await createActor(ctx);
    const m = await addMember(ctx, a, ROLE.manager);
    const outsider = await createActor(ctx);
    await ctx.api.post('/api/v1/projects').set(a.auth).send({ name: `S ${uniq()}` });
    const sr = await ctx.api.post('/api/v1/saved-reports').set(a.auth).send({ name: 'Projects by status', definition: { dataset: 'projects', groupBy: ['status'], aggregations: [{ fn: 'count' }] } });
    expect(sr.status).toBe(201);
    expect((await ctx.api.post('/api/v1/saved-reports').set(a.auth).send({ name: 'Bad', definition: { dataset: 'projects', fields: ['nope'] } })).status).toBe(422);
    const bad = await ctx.api.post('/api/v1/report-schedules').set(a.auth).send({ savedReportId: sr.body.data.id, frequency: 'daily', recipientIds: [outsider.userId] });
    expect(bad.status).toBe(422);
    const ok = await ctx.api.post('/api/v1/report-schedules').set(a.auth).send({ savedReportId: sr.body.data.id, frequency: 'weekly', recipientIds: [m.userId] });
    expect(ok.status).toBe(201);
    await q((t) => t('report_schedules').where({ id: ok.body.data.id }).update({ next_run_at: new Date(Date.now() - 1000) }));
    const before = ctx.mail.outbox.filter((x) => x.to === m.email).length;
    expect(await runDueSchedules(ctx.svc)).toBeGreaterThanOrEqual(1);
    expect(ctx.mail.outbox.filter((x) => x.to === m.email).length).toBe(before + 1);
    expect(await runDueSchedules(ctx.svc)).toBe(0);
    const exp = await ctx.api.post('/api/v1/reports/export').set(a.auth).set('Idempotency-Key', randomUUID())
      .send({ definition: { dataset: 'projects', fields: ['name', 'status'] }, format: 'csv' });
    expect(exp.status).toBe(202);
    await flush(ctx);
    const st = await ctx.api.get(`/api/v1/exports/${exp.body.data.id}`).set(a.auth);
    expect(st.body.data.status).toBe('completed');
  });
});

describe('platform operations', () => {
  it('support access is tenant-granted, time-boxed, read-only and fully audited', async () => {
    const a = await createActor(ctx);
    const pa = await createPlatformAdmin(ctx);
    const no = await ctx.api.post('/api/v1/platform/support/impersonate').set(pa.auth).send({ organizationId: a.organizationId });
    expect(no.status).toBe(403); // no grant
    const grant = await ctx.api.post('/api/v1/organization/support-access').set(a.auth).send({ hours: 1, reason: 'Investigating invoice export issue' });
    expect(grant.status).toBe(201);
    const imp = await ctx.api.post('/api/v1/platform/support/impersonate').set(pa.auth).send({ organizationId: a.organizationId });
    expect(imp.status).toBe(201);
    const sup = { Authorization: `Bearer ${imp.body.data.accessToken}` };
    expect((await ctx.api.get('/api/v1/departments').set(sup)).status).toBe(200);
    expect((await ctx.api.post('/api/v1/departments').set(sup).send({ name: 'Nope' })).status).toBe(403); // read-only
    const sec = await ctx.api.get('/api/v1/security-events').set(a.auth);
    expect(sec.body.data.some((e: { event: string }) => e.event === 'support_access')).toBe(true);
    const aud = await ctx.api.get('/api/v1/audit-events').set(a.auth).query({ action: 'support.session_opened' });
    expect(aud.body.data.length).toBe(1);
    expect((await ctx.api.delete(`/api/v1/organization/support-access/${grant.body.data.id}`).set(a.auth)).status).toBe(204);
    expect((await ctx.api.get('/api/v1/departments').set(sup)).status).toBe(401); // revoked immediately
  });

  it('provisions tenants idempotently and atomically, and exposes health, quotas and diagnostics', async () => {
    const pa = await createPlatformAdmin(ctx);
    const email = `${uniq('owner')}@example.test`;
    const code = `prov-${uniq().slice(0, 8)}`;
    expect((await ctx.api.post('/api/v1/platform/tenants').set(pa.auth).send({ name: 'Prov', adminEmail: email, adminName: 'Owner' })).status).toBe(422); // key required
    const key = randomUUID();
    const body = { name: 'Provisioned Co', code, adminEmail: email, adminName: 'Owner' };
    const first = await ctx.api.post('/api/v1/platform/tenants').set(pa.auth).set('Idempotency-Key', key).send(body);
    expect(first.status).toBe(201);
    const replay = await ctx.api.post('/api/v1/platform/tenants').set(pa.auth).set('Idempotency-Key', key).send(body);
    expect(replay.body.data.organizationId).toBe(first.body.data.organizationId);
    const dup = await ctx.api.post('/api/v1/platform/tenants').set(pa.auth).set('Idempotency-Key', randomUUID()).send({ ...body, adminEmail: `${uniq('o2')}@example.test` });
    expect(dup.status).toBe(409); // code taken: nothing half-created
    const count = await q((t) => t('users').where({ email: body.adminEmail }).count({ c: '*' }).first());
    expect(Number((count as { c: string }).c)).toBe(1);
    const id = first.body.data.organizationId;
    const health = await ctx.api.get(`/api/v1/platform/tenants/${id}/health`).set(pa.auth);
    expect(health.body.data.activeMembers).toBe(1);
    expect((await ctx.api.get(`/api/v1/platform/tenants/${id}/config-check`).set(pa.auth)).body.data.ok).toBe(true);
    expect((await ctx.api.put(`/api/v1/platform/tenants/${id}/quotas`).set(pa.auth).send({ storageBytes: 5_000_000 })).status).toBe(200);
    const diag = await ctx.api.get(`/api/v1/platform/diagnostics/${first.headers['x-request-id']}`).set(pa.auth);
    expect(diag.body.data.audit.length).toBeGreaterThan(0);
    expect((await ctx.api.get('/api/v1/platform/schema-version').set(pa.auth)).body.data.applied.length).toBeGreaterThan(5);
  });

  it('records alerts, deployments, releases and exposes health/metrics/version endpoints', async () => {
    const pa = await createPlatformAdmin(ctx);
    const al = await ctx.api.post('/api/v1/platform/alerts').set(pa.auth).send({ severity: 'warning', title: 'Queue depth high' });
    expect((await ctx.api.post(`/api/v1/platform/alerts/${al.body.data.id}/acknowledge`).set(pa.auth)).body.data.status).toBe('acknowledged');
    expect((await ctx.api.post('/api/v1/platform/deployments').set(pa.auth).send({ version: '1.2.3', environment: 'staging', status: 'succeeded' })).status).toBe(201);
    expect((await ctx.api.post('/api/v1/platform/releases').set(pa.auth).send({ version: '1.2.3', gitSha: 'abc1234' })).status).toBe(201);
    expect((await ctx.api.get('/api/v1/platform/releases').set(pa.auth)).body.data.length).toBeGreaterThan(0);
    expect((await ctx.api.get('/api/v1/health/ready')).body.status).toBe('ready');
    const ver = await ctx.api.get('/api/v1/meta/version');
    expect(ver.body.data.apiVersions).toEqual(['v1']);
    const metrics = await ctx.api.get('/api/v1/metrics');
    expect(metrics.text).toContain('http_request_duration_seconds');
  });
});

describe('help & onboarding', () => {
  it('serves global articles with organization overrides and a checklist from real state', async () => {
    const pa = await createPlatformAdmin(ctx);
    const a = await createActor(ctx);
    const slug = `getting-started-${uniq().slice(0, 6)}`;
    expect((await ctx.api.put(`/api/v1/platform/help/articles/${slug}`).set(pa.auth).send({ title: 'Getting started', body: '<p>Welcome</p><script>x</script>' })).status).toBe(200);
    const g = await ctx.api.get(`/api/v1/help/articles/by-slug/${slug}`).set(a.auth);
    expect(g.body.data.body).toBe('<p>Welcome</p>');
    const own = await ctx.api.post('/api/v1/help/articles').set(a.auth).send({ slug, title: 'Our getting started', body: '<p>Custom</p>', status: 'published' });
    expect(own.status).toBe(201);
    expect((await ctx.api.get(`/api/v1/help/articles/by-slug/${slug}`).set(a.auth)).body.data.title).toBe('Our getting started');
    expect((await ctx.api.post(`/api/v1/help/articles/${own.body.data.id}/feedback`).set(a.auth).send({ helpful: true })).status).toBe(200);
    // tenants cannot edit global articles
    const globalId = (await ctx.api.get('/api/v1/help/articles').set(a.auth).query({ q: 'Getting started' })).body.data.find((x: { scope: string }) => x.scope === 'global')?.id;
    if (globalId) expect((await ctx.api.patch(`/api/v1/help/articles/${globalId}`).set(a.auth).send({ title: 'Hacked' })).status).toBe(404);
    const cl = await ctx.api.get('/api/v1/onboarding/checklist').set(a.auth);
    expect(cl.body.data.total).toBe(5);
    const before = cl.body.data.completed;
    await ctx.api.post('/api/v1/departments').set(a.auth).send({ name: `Eng ${uniq()}` });
    expect((await ctx.api.get('/api/v1/onboarding/checklist').set(a.auth)).body.data.completed).toBe(before + 1);
    void loginActor;
  });
});
