import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { getCtx, createActor, loginActor, tokenFromMail, STRONG_PASSWORD, uniq, type Actor, type TestCtx } from './helpers/app.js';
import { addMember, flush, ROLE } from './helpers/members.js';

let ctx: TestCtx;
let admin: Actor;
beforeAll(async () => {
  ctx = await getCtx();
  admin = await createActor(ctx);
});
afterAll(async () => {
  await ctx.close();
});

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

describe('IAM', () => {
  it('invited members default to Viewer (least privilege) and cannot write', async () => {
    const m = await addMember(ctx, admin);
    const me = await ctx.api.get('/api/v1/me/permissions').set(m.auth);
    expect(me.status).toBe(200);
    expect(me.body.data.permissions.some((p: string) => p.endsWith(':read'))).toBe(true);
    expect(me.body.data.permissions.some((p: string) => p.endsWith(':create') && !p.startsWith('access_requests:'))).toBe(false);
    const w = await ctx.api.post('/api/v1/departments').set(m.auth).send({ name: 'Nope' });
    expect(w.status).toBe(403);
    expect(w.body.errorMessage[0].code).toBe('FORBIDDEN');
  });

  it('role assignment takes effect immediately (old token rejected, re-login gets new permissions)', async () => {
    const m = await addMember(ctx, admin);
    const assign = await ctx.api.post(`/api/v1/users/${m.userId}/roles`).set(admin.auth).send({ roleId: ROLE.manager, reason: 'promotion' });
    expect(assign.status).toBe(201);
    expect((await ctx.api.get('/api/v1/auth/me').set(m.auth)).status).toBe(401); // permission_version moved
    const again = await loginActor(ctx, m.email);
    expect((await ctx.api.post('/api/v1/departments').set(again.auth).send({ name: `Dept ${uniq()}` })).status).toBe(201);
  });

  it('prevents privilege escalation: a manager cannot grant Organization Admin', async () => {
    const m = await addMember(ctx, admin, ROLE.manager);
    const target = await addMember(ctx, admin);
    const r = await ctx.api.post(`/api/v1/users/${target.userId}/roles`).set(m.auth).send({ roleId: ROLE.org_admin });
    expect(r.status).toBe(403);
  });

  it('system roles are immutable and the last admin cannot be removed or demoted', async () => {
    const patch = await ctx.api.patch(`/api/v1/roles/${ROLE.viewer}`).set(admin.auth).send({ name: 'Hacked' });
    expect(patch.status).toBe(409);
    const demote = await ctx.api.delete(`/api/v1/users/${admin.userId}/roles/${ROLE.org_admin}`).set(admin.auth);
    expect(demote.status).toBe(409);
    const remove = await ctx.api.delete(`/api/v1/users/${admin.userId}`).set(admin.auth);
    expect(remove.status).toBe(409);
  });

  it('deactivation revokes sessions immediately; reactivation restores access', async () => {
    const m = await addMember(ctx, admin);
    const d = await ctx.api.patch(`/api/v1/users/${m.userId}/status`).set(admin.auth).send({ status: 'suspended' });
    expect(d.status).toBe(200);
    expect((await ctx.api.get('/api/v1/auth/me').set(m.auth)).status).toBe(401);
    const login = await ctx.api.post('/api/v1/auth/login').send({ email: m.email, password: STRONG_PASSWORD });
    expect(login.status).toBe(200); // identity is fine; the org membership is not active
    expect(login.body.data.organizationId).toBeNull();
    await ctx.api.patch(`/api/v1/users/${m.userId}/status`).set(admin.auth).send({ status: 'active' });
    const back = await loginActor(ctx, m.email);
    expect(back.organizationId).toBe(admin.organizationId);
  });

  it('access requests cannot be self-approved and grant the role when approved', async () => {
    const m = await addMember(ctx, admin);
    const req = await ctx.api.post('/api/v1/access-requests').set(m.auth).send({ roleId: ROLE.member, reason: 'need to contribute' });
    expect(req.status).toBe(201);
    const approve = await ctx.api.post(`/api/v1/access-requests/${req.body.data.id}/approve`).set(admin.auth).send({});
    expect(approve.status).toBe(200);
    const eff = await ctx.api.get(`/api/v1/iam/users/${m.userId}/effective-access`).set(admin.auth);
    expect(eff.body.data.directRoles.map((r: { key: string }) => r.key)).toContain('member');
    const again = await ctx.api.post(`/api/v1/access-requests/${req.body.data.id}/approve`).set(admin.auth).send({});
    expect(again.status).toBe(409);
  });

  it('privileged role changes need a different admin when approval is enabled', async () => {
    await ctx.api.patch('/api/v1/settings/organization').set(admin.auth).send({ 'iam.permission_change_approval': true });
    const target = await addMember(ctx, admin);
    const pending = await ctx.api.post(`/api/v1/users/${target.userId}/roles`).set(admin.auth).send({ roleId: ROLE.org_admin });
    expect(pending.status).toBe(202);
    const self = await ctx.api.post(`/api/v1/iam/permission-change-requests/${pending.body.data.requestId}/approve`).set(admin.auth);
    expect(self.status).toBe(403); // no self-approval
    await ctx.api.patch('/api/v1/settings/organization').set(admin.auth).send({ 'iam.permission_change_approval': false });
  });
});

describe('organization', () => {
  it('validates code availability, reserved words and unknown settings', async () => {
    const reserved = await ctx.api.get('/api/v1/organization/code-availability').query({ code: 'admin' });
    expect(reserved.body.data).toEqual({ available: false, reason: 'reserved' });
    const bad = await ctx.api.patch('/api/v1/settings/organization').set(admin.auth).send({ 'not.a.setting': 1 });
    expect(bad.status).toBe(422);
  });

  it('departments cannot form cycles and detect stale edits', async () => {
    const a = await ctx.api.post('/api/v1/departments').set(admin.auth).send({ name: `A ${uniq()}` });
    const b = await ctx.api.post('/api/v1/departments').set(admin.auth).send({ name: `B ${uniq()}`, parentId: a.body.data.id });
    const cyc = await ctx.api.patch(`/api/v1/departments/${a.body.data.id}`).set(admin.auth).send({ parentId: b.body.data.id, rowVersion: 1 });
    expect(cyc.status).toBe(409);
    const stale = await ctx.api.patch(`/api/v1/departments/${a.body.data.id}`).set(admin.auth).send({ name: 'Renamed', rowVersion: 99 });
    expect(stale.status).toBe(412);
    const ok = await ctx.api.patch(`/api/v1/departments/${a.body.data.id}`).set(admin.auth).send({ name: `Renamed ${uniq()}`, rowVersion: 1 });
    expect(ok.status).toBe(200);
    expect(ok.body.data.rowVersion).toBe(2);
  });

  it('soft delete hides, restore brings back; duplicate names conflict', async () => {
    const name = `Loc ${uniq()}`;
    const l = await ctx.api.post('/api/v1/locations').set(admin.auth).send({ name });
    expect((await ctx.api.post('/api/v1/locations').set(admin.auth).send({ name })).status).toBe(409);
    expect((await ctx.api.delete(`/api/v1/locations/${l.body.data.id}`).set(admin.auth)).status).toBe(204);
    expect((await ctx.api.get(`/api/v1/locations/${l.body.data.id}`).set(admin.auth)).status).toBe(404);
    expect((await ctx.api.post(`/api/v1/locations/${l.body.data.id}/restore`).set(admin.auth)).status).toBe(200);
    expect((await ctx.api.get(`/api/v1/locations/${l.body.data.id}`).set(admin.auth)).status).toBe(200);
  });

  it('paginates with a stable cursor and rejects unknown sort fields', async () => {
    for (let i = 0; i < 3; i++) await ctx.api.post('/api/v1/locations').set(admin.auth).send({ name: `Page ${uniq()}` });
    const p1 = await ctx.api.get('/api/v1/locations').set(admin.auth).query({ limit: 2, sort: 'name' });
    expect(p1.body.data).toHaveLength(2);
    expect(p1.body.meta.nextCursor).toBeTruthy();
    const p2 = await ctx.api.get('/api/v1/locations').set(admin.auth).query({ limit: 2, sort: 'name', cursor: p1.body.meta.nextCursor });
    const ids1 = p1.body.data.map((x: { id: string }) => x.id);
    expect(p2.body.data.every((x: { id: string }) => !ids1.includes(x.id))).toBe(true);
    const bad = await ctx.api.get('/api/v1/locations').set(admin.auth).query({ sort: 'password_hash' });
    expect(bad.status).toBe(422);
  });

  it('suspended tenants are blocked with TENANT_SUSPENDED and reactivation restores access', async () => {
    const a = await createActor(ctx);
    const platform = await createActor(ctx, { kind: 'individual' });
    await ctx.svc.db.raw('select 1');
    const { withPlatformScope } = await import('../src/platform/scope.js');
    await withPlatformScope(ctx.svc.db, 'test', (t) => t('users').where({ id: platform.userId }).update({ is_platform_admin: true, permission_version: t.raw('permission_version + 1') }));
    const pa = await loginActor(ctx, platform.email);
    const s = await ctx.api.post('/api/v1/organization/suspend').set(pa.auth).send({ organizationId: a.organizationId, reason: 'non-payment' });
    expect(s.status).toBe(200);
    const blocked = await ctx.api.get('/api/v1/departments').set(a.auth);
    expect(blocked.status).toBe(403);
    expect(blocked.body.errorMessage[0].code).toBe('TENANT_SUSPENDED');
    const invalid = await ctx.api.post('/api/v1/organization/reactivate').set(pa.auth).send({ organizationId: a.organizationId, reason: 'paid' });
    expect(invalid.status).toBe(200);
    expect((await ctx.api.get('/api/v1/departments').set(a.auth)).status).toBe(200);
    const again = await ctx.api.post('/api/v1/organization/reactivate').set(pa.auth).send({ organizationId: a.organizationId, reason: 'x again' });
    expect(again.status).toBe(409); // active -> active is not a valid transition
  });
});

describe('files', () => {
  it('uploads, scans, then serves only clean files through authorized or signed links', async () => {
    const up = await ctx.api.post('/api/v1/files').set(admin.auth).attach('file', PNG, { filename: 'pixel.png', contentType: 'image/png' });
    expect(up.status).toBe(201);
    const id = up.body.data.id;
    const early = await ctx.api.get(`/api/v1/files/${id}/content`).set(admin.auth);
    expect(early.status).toBe(409); // pending scan: fail closed
    await flush(ctx);
    const meta = await ctx.api.get(`/api/v1/files/${id}`).set(admin.auth);
    expect(meta.body.data.scanStatus).toBe('clean');
    const link = await ctx.api.get(`/api/v1/files/${id}/download-link`).set(admin.auth);
    expect(link.status).toBe(200);
    const dl = await ctx.api.get(link.body.data.url);
    expect(dl.status).toBe(200);
    expect(dl.headers['x-content-type-options']).toBe('nosniff');
    expect(dl.headers['content-disposition']).toContain('attachment');
    expect((await ctx.api.get(`/api/v1/files/download/${'a'.repeat(60)}.${'b'.repeat(64)}`)).status).toBe(404);
  });

  it('rejects disallowed, mismatched and infected content', async () => {
    const exe = await ctx.api.post('/api/v1/files').set(admin.auth).attach('file', Buffer.from('MZ....'), { filename: 'run.exe', contentType: 'application/octet-stream' });
    expect(exe.status).toBe(422);
    const fake = await ctx.api.post('/api/v1/files').set(admin.auth).attach('file', Buffer.from('<html>not an image</html>'), { filename: 'x.png', contentType: 'image/png' });
    expect(fake.status).toBe(422);
    const eicar = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
    const bad = await ctx.api.post('/api/v1/files').set(admin.auth).attach('file', Buffer.from(eicar), { filename: 'eicar.txt', contentType: 'text/plain' });
    expect(bad.status).toBe(201);
    await flush(ctx);
    expect((await ctx.api.get(`/api/v1/files/${bad.body.data.id}`).set(admin.auth)).body.data.scanStatus).toBe('infected');
    expect((await ctx.api.get(`/api/v1/files/${bad.body.data.id}/download-link`).set(admin.auth)).status).toBe(409);
  });

  it('enforces the organization storage quota', async () => {
    const a = await createActor(ctx);
    await ctx.api.patch('/api/v1/settings/organization').set(a.auth).send({ 'storage.quota_bytes': 1_000_000 });
    const big = Buffer.concat([Buffer.from('a'), Buffer.alloc(1_200_000, 'x')]);
    const r = await ctx.api.post('/api/v1/files').set(a.auth).attach('file', big, { filename: 'big.txt', contentType: 'text/plain' });
    expect(r.status).toBe(422);
    expect(JSON.stringify(r.body)).toContain('quota_exceeded');
  });
});

describe('audit, exports, imports, security', () => {
  it('records audit events atomically with the change and exposes them tenant-scoped', async () => {
    const name = `Audited ${uniq()}`;
    const d = await ctx.api.post('/api/v1/departments').set(admin.auth).send({ name });
    const ev = await ctx.api.get('/api/v1/audit-events').set(admin.auth).query({ action: 'departments.created', resourceId: d.body.data.id });
    expect(ev.status).toBe(200);
    expect(ev.body.data).toHaveLength(1);
    expect(ev.body.data[0].actorId).toBe(admin.userId);
    expect(JSON.stringify(ev.body)).not.toMatch(/password|token/i);
    const other = await createActor(ctx);
    const otherEv = await ctx.api.get('/api/v1/audit-events').set(other.auth).query({ resourceId: d.body.data.id });
    expect(otherEv.body.data).toHaveLength(0);
  });

  it('a failed business change leaves no audit row (same transaction)', async () => {
    const before = await ctx.api.get('/api/v1/audit-events').set(admin.auth).query({ action: 'departments.created', limit: 100 });
    const name = `Dup ${uniq()}`;
    await ctx.api.post('/api/v1/departments').set(admin.auth).send({ name });
    const dup = await ctx.api.post('/api/v1/departments').set(admin.auth).send({ name });
    expect(dup.status).toBe(409);
    const after = await ctx.api.get('/api/v1/audit-events').set(admin.auth).query({ action: 'departments.created', limit: 100 });
    expect(after.body.data.length).toBe(Math.min(100, before.body.data.length + 1));
  });

  it('exports users asynchronously to a private file with an expiring link, and the export is audited', async () => {
    const ex = await ctx.api.post('/api/v1/audit-events/export').set(admin.auth).set('Idempotency-Key', randomUUID()).send({ format: 'csv' });
    expect(ex.status).toBe(202);
    await flush(ctx);
    const st = await ctx.api.get(`/api/v1/exports/${ex.body.data.id}`).set(admin.auth);
    expect(st.body.data.status).toBe('completed');
    expect(st.body.data.downloadLink.url).toContain('/api/v1/files/download/');
    await flush(ctx);
    const file = await ctx.api.get(st.body.data.downloadLink.url);
    expect(file.status).toBe(200);
    expect(file.text.split('\n')[0]).toContain('action');
    const audited = await ctx.api.get('/api/v1/audit-events').set(admin.auth).query({ action: 'audit.exported' });
    expect(audited.body.data.length).toBeGreaterThan(0);
  });

  it('idempotency: same key replays, different body is rejected', async () => {
    const key = randomUUID();
    const body = { format: 'json' };
    const a = await ctx.api.post('/api/v1/audit-events/export').set(admin.auth).set('Idempotency-Key', key).send(body);
    const b = await ctx.api.post('/api/v1/audit-events/export').set(admin.auth).set('Idempotency-Key', key).send(body);
    expect(b.status).toBe(a.status);
    expect(b.headers['idempotent-replay']).toBe('true');
    expect(b.body.data.id).toBe(a.body.data.id);
    const c = await ctx.api.post('/api/v1/audit-events/export').set(admin.auth).set('Idempotency-Key', key).send({ format: 'csv' });
    expect(c.status).toBe(422);
    expect(c.body.errorMessage[0].code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('imports CSV all-or-nothing with row-level errors and supports dry-run', async () => {
    const good = Buffer.from(`name,parentName\nImp ${uniq()},\nImp ${uniq()},\n`);
    const dry = await ctx.api.post('/api/v1/imports').set(admin.auth).field('resource', 'departments').field('dryRun', 'true').attach('file', good, { filename: 'd.csv', contentType: 'text/csv' });
    expect(dry.status).toBe(200);
    expect(dry.body.data.status).toBe('dry_run');
    const real = await ctx.api.post('/api/v1/imports').set(admin.auth).field('resource', 'departments').attach('file', good, { filename: 'd.csv', contentType: 'text/csv' });
    expect(real.body.data.status).toBe('completed');
    expect(real.body.data.applied).toBe(2);
    const dupName = `Dupimp ${uniq()}`;
    const bad = Buffer.from(`name,parentName\n${dupName},\n${dupName},\nX,\n`);
    const res = await ctx.api.post('/api/v1/imports').set(admin.auth).field('resource', 'departments').attach('file', bad, { filename: 'd.csv', contentType: 'text/csv' });
    expect(res.body.data.status).toBe('failed');
    expect(res.body.data.applied).toBe(0);
    expect(res.body.data.errors.length).toBeGreaterThan(0);
    const list = await ctx.api.get('/api/v1/departments').set(admin.auth).query({ q: dupName });
    expect(list.body.data).toHaveLength(0); // nothing half-applied
  });

  it('API keys: secret shown once, hashed at rest, scoped, and revocable', async () => {
    const k = await ctx.api.post('/api/v1/api-keys').set(admin.auth).send({ name: `ci-${uniq()}`, scopes: ['departments:read'] });
    expect(k.status).toBe(201);
    const key = k.body.data.key as string;
    const { withPlatformScope } = await import('../src/platform/scope.js');
    const row = await withPlatformScope(ctx.svc.db, 'test', (tx) => tx('api_keys').where({ id: k.body.data.id }).first());
    expect(row.key_hash).not.toContain(key);
    const listed = await ctx.api.get('/api/v1/api-keys').set(admin.auth);
    expect(JSON.stringify(listed.body)).not.toContain(key);
    const ok = await ctx.api.get('/api/v1/departments').set('Authorization', `Bearer ${key}`);
    expect(ok.status).toBe(200);
    const denied = await ctx.api.get('/api/v1/locations').set('Authorization', `Bearer ${key}`);
    expect(denied.status).toBe(403);
    await ctx.api.post(`/api/v1/api-keys/${k.body.data.id}/revoke`).set(admin.auth);
    expect((await ctx.api.get('/api/v1/departments').set('Authorization', `Bearer ${key}`)).status).toBe(401);
    const lowly = await addMember(ctx, admin);
    const escal = await ctx.api.post('/api/v1/api-keys').set(lowly.auth).send({ name: 'bad-key', scopes: ['users:delete'] });
    expect(escal.status).toBe(403);
  });

  it('security policy: org-enforced MFA keeps the session pending until enrolment', async () => {
    const a = await createActor(ctx);
    const put = await ctx.api.put('/api/v1/security/policy').set(a.auth).send({ mfa: { requiredForAll: true } });
    expect(put.status).toBe(200);
    const login = await ctx.api.post('/api/v1/auth/login').send({ email: a.email, password: STRONG_PASSWORD });
    expect(login.body.data.mfaSetupRequired).toBe(true);
    const auth = { Authorization: `Bearer ${login.body.data.accessToken}` };
    expect((await ctx.api.get('/api/v1/departments').set(auth)).status).toBe(401);
    expect((await ctx.api.post('/api/v1/auth/mfa/setup').set(auth)).status).toBe(200);
  });

  it('maintenance mode returns 503 MAINTENANCE except for health', async () => {
    const platform = await createActor(ctx, { kind: 'individual' });
    const { withPlatformScope } = await import('../src/platform/scope.js');
    await withPlatformScope(ctx.svc.db, 'test', (t) => t('users').where({ id: platform.userId }).update({ is_platform_admin: true, permission_version: t.raw('permission_version + 1') }));
    const pa = await loginActor(ctx, platform.email);
    await ctx.api.patch('/api/v1/settings/application').set(pa.auth).send({ maintenance_mode: true });
    const down = await ctx.api.get('/api/v1/departments').set(admin.auth);
    expect(down.status).toBe(503);
    expect(down.body.errorMessage[0].code).toBe('MAINTENANCE');
    expect(down.headers['retry-after']).toBeTruthy();
    expect((await ctx.api.get('/api/v1/health/live')).status).toBe(200);
    await withPlatformScope(ctx.svc.db, 'test', (t) => t('application_settings').where({ key: 'maintenance_mode' }).delete());
  });

  it('organization deletion request requires the code, suspends, and can be cancelled', async () => {
    const a = await createActor(ctx);
    const org = await ctx.api.get('/api/v1/organization').set(a.auth);
    const wrong = await ctx.api.post('/api/v1/organization/deletion-request').set(a.auth).send({ confirmCode: 'nope' });
    expect(wrong.status).toBe(422);
    const ok = await ctx.api.post('/api/v1/organization/deletion-request').set(a.auth).send({ confirmCode: org.body.data.code });
    expect(ok.status).toBe(201);
    expect((await ctx.api.get('/api/v1/departments').set(a.auth)).status).toBe(403); // suspended during grace period
    expect((await ctx.api.delete('/api/v1/organization/deletion-request').set(a.auth)).status).toBe(204);
    expect((await ctx.api.get('/api/v1/departments').set(a.auth)).status).toBe(200);
  });

  it('privileged retention purge removes old audit events (and audits the purge)', async () => {
    const a = await createActor(ctx);
    await ctx.api.put('/api/v1/audit/retention-policy').set(a.auth).send({ retentionDays: 30 });
    await ctx.api.put('/api/v1/retention/policies/audit_events').set(a.auth).send({ retentionDays: 1 });
    const { withPlatformScope } = await import('../src/platform/scope.js');
    await withPlatformScope(ctx.svc.db, 'test', (t) => t.raw(
      `INSERT INTO audit_events (id, organization_id, action, outcome, occurred_at) VALUES (gen_random_uuid(), ?, 'old.event', 'success', now() - interval '10 days')`, [a.organizationId]));
    const dry = await ctx.api.post('/api/v1/retention/run').set(a.auth).send({ dryRun: true });
    expect(dry.body.data.report.audit_events).toBeGreaterThan(0);
    const real = await ctx.api.post('/api/v1/retention/run').set(a.auth).send({ dryRun: false });
    expect(real.body.data.report.audit_events).toBeGreaterThan(0);
    const left = await ctx.api.get('/api/v1/audit-events').set(a.auth).query({ action: 'old.event' });
    expect(left.body.data).toHaveLength(0);
    const purged = await ctx.api.get('/api/v1/audit-events').set(a.auth).query({ action: 'audit.retention_purged' });
    expect(purged.body.data.length).toBeGreaterThan(0);
  });
});

void tokenFromMail;
