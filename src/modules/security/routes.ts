import { z } from 'zod';
import { defineRoute } from '../../platform/http/route.js';
import { AppError } from '../../platform/errors.js';
import { decrypt, encrypt, newId, randomToken, sha256 } from '../../platform/crypto.js';
import { paginate, listQuerySchema, type ListQuery } from '../../platform/pagination.js';
import { rowToApi, mapDbError } from '../../platform/crud.js';
import { DEFAULT_SECURITY_POLICY } from '../../platform/security-policy.js';
import { saveFile } from '../../platform/files.js';
import { requestExport } from '../data/exports.js';

const M = 'security';
const obj = z.record(z.string(), z.unknown());
const idParams = z.object({ id: z.string().uuid() });

// ---- policy (F-152) -------------------------------------------------------------------------------------------

const policySchema = z.object({
  password: z.object({
    minLength: z.number().int().min(8).max(128), requireClasses: z.number().int().min(1).max(4), historyDepth: z.number().int().min(0).max(24),
  }).partial(),
  session: z.object({ idleMinutes: z.number().int().min(5).max(60 * 24 * 30), absoluteMinutes: z.number().int().min(15).max(60 * 24 * 90) }).partial(),
  lockout: z.object({ threshold: z.number().int().min(3).max(20), baseMinutes: z.number().int().min(1).max(60), maxMinutes: z.number().int().min(1).max(1440) }).partial(),
  mfa: z.object({ requiredForAll: z.boolean(), requiredForRoles: z.array(z.string().max(60)).max(20) }).partial(),
  allowedIpRanges: z.array(z.string().max(64)).max(50),
}).partial();

defineRoute({
  method: 'get', path: '/security/policy', module: M, summary: 'Effective security policy', access: { permission: 'security:read' }, response: obj,
  async handler(c) {
    const row = await c.trx('security_policies').where({ organization_id: c.orgId() }).first();
    return { data: { defaults: DEFAULT_SECURITY_POLICY, organization: row?.policy ?? {} } };
  },
});

defineRoute({
  method: 'put', path: '/security/policy', module: M, summary: 'Set the organization security policy',
  access: { permission: 'security:update' }, body: policySchema, response: obj,
  audit: { action: 'security.policy_changed', resourceType: 'security_policy' },
  async handler(c) {
    const p = c.body as { session?: { idleMinutes?: number; absoluteMinutes?: number } };
    if (p.session?.idleMinutes && p.session?.absoluteMinutes && p.session.idleMinutes > p.session.absoluteMinutes) {
      throw new AppError('VALIDATION_FAILED', 'Idle timeout cannot exceed absolute timeout', [{ field: 'session.idleMinutes', issue: 'exceeds absolute' }]);
    }
    const existing = await c.trx('security_policies').where({ organization_id: c.orgId() }).first();
    if (existing) {
      await c.trx('security_policies').where({ id: existing.id }).update({ policy: JSON.stringify(c.body), updated_at: c.svc.now(), updated_by: c.auth!.userId });
    } else {
      await c.trx('security_policies').insert({ id: newId(), organization_id: c.orgId(), policy: JSON.stringify(c.body), updated_by: c.auth!.userId });
    }
    return { status: 200, data: { organization: c.body }, auditResourceId: c.orgId() };
  },
});

// ---- API keys (F-154) -------------------------------------------------------------------------------------------

const mintKey = () => {
  const prefix = randomToken(5).replace(/[-_]/g, 'a').toLowerCase();
  return { prefix, key: `nxk_${prefix}_${randomToken(32)}` };
};

defineRoute({
  method: 'post', path: '/api-keys', module: M, summary: 'Create an API key (secret shown once)',
  access: { permission: 'api_keys:create' }, rateLimit: 'apikey', idempotent: true, entitlement: { key: 'api_access' },
  body: z.object({
    name: z.string().trim().min(2).max(80),
    scopes: z.array(z.string().max(80)).min(1).max(100),
    expiresAt: z.string().datetime().optional(),
  }), response: obj, audit: { action: 'api_key.created', resourceType: 'api_key' },
  async handler(c) {
    const missing = c.body.scopes.filter((s) => !c.auth!.permissions.has(s));
    if (missing.length) throw new AppError('FORBIDDEN', 'You cannot grant scopes you do not hold', missing.map((m) => ({ field: 'scopes', issue: m })));
    if (c.body.expiresAt && new Date(c.body.expiresAt) <= c.svc.now()) throw new AppError('VALIDATION_FAILED', 'expiresAt must be in the future', [{ field: 'expiresAt', issue: 'past' }]);
    const { prefix, key } = mintKey();
    const id = newId();
    await c.trx('api_keys').insert({
      id, organization_id: c.orgId(), name: c.body.name, prefix, key_hash: sha256(key), scopes: c.body.scopes,
      expires_at: c.body.expiresAt ?? null, created_by: c.auth!.userId,
    });
    return { status: 201, data: { id, name: c.body.name, prefix, scopes: c.body.scopes, key } };
  },
});

defineRoute({
  method: 'get', path: '/api-keys', module: M, summary: 'List API keys (never returns secrets)', access: { permission: 'api_keys:read' },
  query: listQuerySchema, response: obj,
  async handler(c) {
    const qb = c.trx('api_keys').where({ organization_id: c.orgId() }).select('id', 'name', 'prefix', 'scopes', 'expires_at', 'last_used_at', 'revoked_at', 'created_at');
    const page = await paginate(qb, c.query as ListQuery, { sortable: { created_at: 'created_at', name: 'name' }, defaultSort: '-created_at' });
    return { data: page.data.map((r) => rowToApi(r)), meta: page.meta };
  },
});

defineRoute({
  method: 'post', path: '/api-keys/:id/revoke', module: M, summary: 'Revoke an API key', access: { permission: 'api_keys:delete' },
  params: idParams, response: obj, audit: { action: 'api_key.revoked', resourceType: 'api_key' },
  async handler(c) {
    const n = await c.trx('api_keys').where({ id: c.params.id, organization_id: c.orgId() }).whereNull('revoked_at').update({ revoked_at: c.svc.now() });
    if (!n) throw new AppError('NOT_FOUND', 'API key not found');
    return { status: 200, data: { id: c.params.id, revoked: true } };
  },
});

defineRoute({
  method: 'post', path: '/api-keys/:id/rotate', module: M, summary: 'Rotate an API key with an overlap window',
  access: { permission: 'api_keys:create' }, params: idParams, body: z.object({ overlapMinutes: z.number().int().min(0).max(1440).default(60) }),
  response: obj, audit: { action: 'api_key.rotated', resourceType: 'api_key' },
  async handler(c) {
    const old = await c.trx('api_keys').where({ id: c.params.id, organization_id: c.orgId() }).whereNull('revoked_at').first();
    if (!old) throw new AppError('NOT_FOUND', 'API key not found');
    const { prefix, key } = mintKey();
    const id = newId();
    await c.trx('api_keys').insert({
      id, organization_id: c.orgId(), name: old.name, prefix, key_hash: sha256(key), scopes: old.scopes,
      expires_at: old.expires_at, created_by: c.auth!.userId,
    });
    const until = new Date(c.svc.now().getTime() + c.body.overlapMinutes * 60_000);
    await c.trx('api_keys').where({ id: old.id }).update({ expires_at: until }); // old key dies after the overlap window
    return { status: 201, data: { id, prefix, key, previousKeyExpiresAt: until.toISOString() } };
  },
});

// ---- privacy requests (F-158) -------------------------------------------------------------------------------------

defineRoute({
  method: 'post', path: '/privacy-requests', module: M, summary: 'Create a data-subject request',
  access: { permission: 'privacy:create' },
  body: z.object({ kind: z.enum(['access', 'export', 'erasure', 'rectification']), subjectUserId: z.string().uuid().optional(), notes: z.string().max(1000).optional() }),
  response: obj, audit: { action: 'privacy_request.created', resourceType: 'privacy_request' },
  async handler(c) {
    const subject = c.body.subjectUserId ?? c.auth!.userId;
    if (subject !== c.auth!.userId && !c.auth!.permissions.has('privacy:manage')) throw new AppError('FORBIDDEN', 'You can only file requests for yourself');
    const m = await c.trx('organization_memberships').where({ organization_id: c.orgId(), user_id: subject }).first();
    if (!m) throw new AppError('NOT_FOUND', 'User not found');
    const id = newId();
    await c.trx('privacy_requests').insert({
      id, organization_id: c.orgId(), subject_user_id: subject, kind: c.body.kind, notes: c.body.notes ?? null,
      due_at: new Date(c.svc.now().getTime() + 30 * 86400_000),
    });
    return { status: 201, data: { id, status: 'open' } };
  },
});

defineRoute({
  method: 'get', path: '/privacy-requests', module: M, summary: 'List data-subject requests', access: { permission: 'privacy:read' },
  query: listQuerySchema, response: obj,
  async handler(c) {
    const qb = c.trx('privacy_requests').where({ organization_id: c.orgId() });
    if (!c.auth!.permissions.has('privacy:manage')) qb.where({ subject_user_id: c.auth!.userId });
    const page = await paginate(qb, c.query as ListQuery, { sortable: { created_at: 'created_at', due_at: 'due_at' }, filterable: { status: 'status', kind: 'kind' }, defaultSort: '-created_at' });
    return { data: page.data.map((r) => rowToApi(r)), meta: page.meta };
  },
});

defineRoute({
  method: 'post', path: '/privacy-requests/:id/process', module: M, summary: 'Fulfil a data-subject request (export package or erasure)',
  access: { permission: 'privacy:manage' }, params: idParams, response: obj,
  audit: { action: 'privacy_request.processed', resourceType: 'privacy_request' },
  async handler(c) {
    const r = await c.trx('privacy_requests').where({ id: c.params.id, organization_id: c.orgId() }).forUpdate().first();
    if (!r) throw new AppError('NOT_FOUND', 'Privacy request not found');
    if (r.status === 'completed' || r.status === 'rejected') throw new AppError('CONFLICT', 'Request already closed');
    const subject = await c.trx('users').where({ id: r.subject_user_id }).first();
    let result: Record<string, unknown> = {};
    if (r.kind === 'access' || r.kind === 'export') {
      const events = await c.trx('audit_events').where({ organization_id: c.orgId(), actor_id: subject.id }).orderBy('occurred_at', 'desc').limit(5000)
        .select('occurred_at', 'action', 'resource_type', 'resource_id', 'outcome');
      const memberships = await c.trx('organization_memberships').where({ organization_id: c.orgId(), user_id: subject.id }).select('status', 'joined_at');
      const pkg = { subject: { id: subject.id, email: subject.email, name: subject.name, locale: subject.locale, timezone: subject.timezone }, memberships, auditEvents: events };
      const file = await saveFile(c.svc, c.trx, {
        organizationId: c.orgId(), ownerId: c.auth!.userId, filename: `data-subject-${subject.id.slice(0, 8)}.json`,
        data: Buffer.from(JSON.stringify(pkg, null, 2)), purpose: 'privacy',
      });
      result = { fileId: file.id };
    } else if (r.kind === 'erasure') {
      const m = await c.trx('organization_memberships').where({ organization_id: c.orgId(), user_id: subject.id }).first();
      const org = await c.trx('organizations').where({ id: c.orgId() }).first();
      if (org.owner_user_id === subject.id) throw new AppError('CONFLICT', 'Transfer ownership before erasing the owner');
      if (m) {
        await c.trx('user_role_assignments').where({ membership_id: m.id }).delete();
        await c.trx('user_group_members').where({ membership_id: m.id }).delete();
        await c.trx('organization_memberships').where({ id: m.id }).update({ status: 'removed' });
      }
      await c.trx('sessions').where({ user_id: subject.id, active_organization_id: c.orgId() }).whereNull('revoked_at').update({ revoked_at: c.svc.now(), revoked_reason: 'erasure' });
      const others = await c.trx.raw(`SELECT 1 FROM organization_memberships WHERE user_id = ? AND status <> 'removed' LIMIT 1`, [subject.id]);
      if (others.rows.length === 0) {
        // last tenant: anonymize the identity; audit rows keep the opaque id (legal retention)
        const t = c.trx; // same transaction: no second connection contending for the same session rows
        await t('users').where({ id: subject.id }).update({
          email: `erased-${subject.id}@invalid.example`, name: 'Erased user', password_hash: null, status: 'deactivated',
          permission_version: t.raw('permission_version + 1'),
        });
        await t('mfa_factors').where({ user_id: subject.id }).delete();
        await t('sessions').where({ user_id: subject.id }).whereNull('revoked_at').update({ revoked_at: new Date(), revoked_reason: 'erasure' });
        result = { anonymized: true };
      } else result = { anonymized: false, removedFromOrganization: true };
    } else {
      result = { note: 'Rectification is applied through the profile endpoints' };
    }
    await c.trx('privacy_requests').where({ id: r.id }).update({ status: 'completed', handled_by: c.auth!.userId, completed_at: c.svc.now() });
    return { status: 200, data: { id: r.id, status: 'completed', ...result }, auditResourceId: r.id };
  },
});

// ---- secret references + key rotation -----------------------------------------------------------------------------

defineRoute({
  method: 'post', path: '/security/secret-references', module: M, summary: 'Register a secret reference (names only, never values)',
  access: { permission: 'security:update' }, body: z.object({ name: z.string().regex(/^[A-Z0-9_]{3,64}$/), provider: z.string().max(40).default('env') }),
  response: obj, audit: { action: 'secret_reference.created', resourceType: 'secret_reference' },
  async handler(c) {
    const id = newId();
    try { await c.trx('secret_references').insert({ id, organization_id: c.orgId(), name: c.body.name, provider: c.body.provider }); }
    catch (e) { throw mapDbError(e); }
    return { status: 201, data: { id, ...c.body, version: 1 } };
  },
});

defineRoute({
  method: 'get', path: '/security/secret-references', module: M, summary: 'List secret references', access: { permission: 'security:read' }, response: obj,
  async handler(c) {
    return { data: (await c.trx('secret_references').where({ organization_id: c.orgId() }).orderBy('name')).map((r) => rowToApi(r)) };
  },
});

defineRoute({
  method: 'post', path: '/platform/security/rotate-encryption-key', module: M, summary: 'Re-encrypt stored secrets with the current key version',
  access: 'platformAdmin', response: obj,
  async handler(c) {
    const rows = await c.trx('mfa_factors').select('id', 'secret_encrypted');
    let n = 0;
    for (const r of rows) {
      const fresh = encrypt(c.svc.keys, decrypt(c.svc.keys, r.secret_encrypted));
      if (!r.secret_encrypted.startsWith(`v${c.svc.keys.current().version}.`)) {
        await c.trx('mfa_factors').where({ id: r.id }).update({ secret_encrypted: fresh });
        n++;
      }
    }
    await c.audit({ action: 'security.encryption_key_rotated', resourceType: 'encryption_key', metadata: { reencrypted: n, version: c.svc.keys.current().version } });
    return { status: 200, data: { reencrypted: n, keyVersion: c.svc.keys.current().version } };
  },
});

void requestExport;
