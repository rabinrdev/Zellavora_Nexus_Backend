import { z } from 'zod';
import { defineRoute } from '../../platform/http/route.js';
import { AppError } from '../../platform/errors.js';
import { newId } from '../../platform/crypto.js';
import { deepScrub } from '../../platform/redact.js';
import { evaluateAll, MODULE_FLAGS } from '../../platform/flags.js';
import { withPlatformScope } from '../../platform/scope.js';
import { mapDbError, rowToApi } from '../../platform/crud.js';

const M = 'settings';
const obj = z.record(z.string(), z.unknown());

/** Typed registry: unknown keys are rejected; each key has its own validator. */
export const ORG_SETTINGS = {
  'iam.permission_change_approval': z.boolean(),
  'iam.default_member_role': z.enum(['viewer', 'member', 'none']),
  'storage.quota_bytes': z.number().int().min(1_000_000).max(10 ** 13),
  'timesheets.max_hours_per_day': z.number().min(1).max(24),
  'timesheets.work_week': z.array(z.number().int().min(0).max(6)).min(1).max(7),
  'timesheets.work_hours_per_day': z.number().min(1).max(24),
  'approvals.prevent_self_approval': z.boolean(),
  'notifications.digest': z.enum(['off', 'daily', 'weekly']),
  'branding.show_logo': z.boolean(),
  'invoices.default_payment_terms_days': z.number().int().min(0).max(365),
  'invoices.rounding': z.enum(['half_up', 'half_even', 'down', 'up']),
} as const satisfies Record<string, z.ZodType>;

export const APP_SETTINGS = {
  maintenance_mode: z.boolean(),
  maintenance_message: z.string().max(300),
  signup_enabled: z.boolean(),
} as const satisfies Record<string, z.ZodType>;

function validateSettings(registry: Record<string, z.ZodType>, input: Record<string, unknown>) {
  const issues: { field: string; issue: string }[] = [];
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    const schema = registry[k];
    if (!schema) { issues.push({ field: k, issue: 'unknown setting' }); continue; }
    const r = schema.safeParse(v);
    if (!r.success) issues.push({ field: k, issue: r.error.issues[0]?.message ?? 'invalid' });
    else out[k] = r.data;
  }
  if (issues.length) throw new AppError('VALIDATION_FAILED', 'Invalid settings', issues);
  return out;
}

defineRoute({
  method: 'get', path: '/settings/organization', module: M, summary: 'Organization settings',
  access: { permission: 'settings:read' }, response: obj,
  async handler(c) {
    const rows = await c.trx('organization_settings').where({ organization_id: c.orgId() });
    const out: Record<string, unknown> = {};
    for (const r of rows) out[r.key] = r.value;
    return { data: { values: out, registry: Object.keys(ORG_SETTINGS) } };
  },
});

defineRoute({
  method: 'patch', path: '/settings/organization', module: M, summary: 'Update organization settings',
  access: { permission: 'settings:update' }, body: z.record(z.string().max(80), z.unknown()), response: obj,
  audit: { action: 'organization.settings_changed', resourceType: 'organization_settings' },
  async handler(c) {
    const values = validateSettings(ORG_SETTINGS, c.body);
    const changes: Record<string, { old: unknown; new: unknown }> = {};
    for (const [k, v] of Object.entries(values)) {
      const prev = await c.trx('organization_settings').where({ organization_id: c.orgId(), key: k }).first();
      changes[k] = { old: prev?.value ?? null, new: v };
      await c.trx('organization_settings').insert({
        organization_id: c.orgId(), key: k, value: JSON.stringify(v), updated_at: c.svc.now(), updated_by: c.auth!.userId,
      }).onConflict(['organization_id', 'key']).merge(['value', 'updated_at', 'updated_by']);
    }
    await c.audit({ action: 'organization.settings_diff', resourceType: 'organization_settings', metadata: deepScrub({ changes }) });
    await c.emit('organization.settings_changed', { keys: Object.keys(values) });
    return { status: 200, data: { updated: Object.keys(values) }, auditResourceId: c.orgId() };
  },
});

defineRoute({
  method: 'get', path: '/settings/application', module: M, summary: 'Global application settings (platform admin)',
  access: 'platformAdmin', response: obj,
  async handler(c) {
    const rows = await c.trx('application_settings');
    const out: Record<string, unknown> = {};
    for (const r of rows) out[r.key] = r.value;
    return { data: out };
  },
});

defineRoute({
  method: 'patch', path: '/settings/application', module: M, summary: 'Update global application settings (platform admin)',
  access: 'platformAdmin', body: z.record(z.string().max(80), z.unknown()), response: obj,
  async handler(c) {
    const values = validateSettings(APP_SETTINGS, c.body);
    for (const [k, v] of Object.entries(values)) {
      await c.trx('application_settings').insert({ key: k, value: JSON.stringify(v), updated_by: c.auth!.userId })
        .onConflict('key').merge(['value', 'updated_by', 'updated_at']);
    }
    await c.audit({ action: 'application.settings_changed', resourceType: 'application_settings', metadata: deepScrub({ keys: Object.keys(values) }) });
    return { status: 200, data: { updated: Object.keys(values) } };
  },
});

// ---- user profile & preferences -----------------------------------------------------------------------------

const timezone = z.string().min(1).max(64).refine((tz) => {
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; }
}, 'unknown timezone');

defineRoute({
  method: 'get', path: '/me/profile', module: M, summary: 'My profile', access: 'authenticated', scope: 'user', allowSuspendedTenant: true, response: obj,
  async handler(c) {
    const u = await c.trx('users').where({ id: c.auth!.userId }).first('id', 'email', 'name', 'locale', 'timezone', 'email_verified_at', 'created_at');
    return { data: rowToApi(u) };
  },
});

defineRoute({
  method: 'patch', path: '/me/profile', module: M, summary: 'Update my profile', access: 'authenticated', scope: 'user',
  body: z.object({ name: z.string().trim().min(1).max(120).optional(), locale: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/).optional(), timezone: timezone.optional() }),
  response: obj,
  async handler(c) {
    await c.trx('users').where({ id: c.auth!.userId }).update({ ...c.body, updated_at: c.svc.now() });
    const u = await c.trx('users').where({ id: c.auth!.userId }).first('id', 'email', 'name', 'locale', 'timezone');
    return { status: 200, data: rowToApi(u) };
  },
});

const preferences = z.object({
  dateFormat: z.enum(['YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY']).optional(),
  timeFormat: z.enum(['24h', '12h']).optional(),
  numberFormat: z.enum(['1,234.56', '1.234,56', '1 234,56']).optional(),
  weekStart: z.number().int().min(0).max(6).optional(),
  theme: z.enum(['system', 'light', 'dark']).optional(),
});

defineRoute({
  method: 'get', path: '/me/preferences', module: M, summary: 'My display preferences', access: 'authenticated', scope: 'user', response: obj,
  async handler(c) {
    const p = await c.trx('user_preferences').where({ user_id: c.auth!.userId }).first();
    return { data: p?.preferences ?? {} };
  },
});

defineRoute({
  method: 'patch', path: '/me/preferences', module: M, summary: 'Update my display preferences', access: 'authenticated', scope: 'user',
  body: preferences, response: obj,
  async handler(c) {
    const cur = await c.trx('user_preferences').where({ user_id: c.auth!.userId }).first();
    const merged = { ...(cur?.preferences ?? {}), ...c.body };
    await c.trx('user_preferences').insert({ user_id: c.auth!.userId, preferences: JSON.stringify(merged) })
      .onConflict('user_id').merge({ preferences: JSON.stringify(merged), updated_at: c.svc.now() });
    return { status: 200, data: merged };
  },
});

// ---- lookups --------------------------------------------------------------------------------------------------

defineRoute({
  method: 'get', path: '/lookups/:type', module: M, summary: 'Lookup values (system + organization)',
  access: { permission: 'lookups:read' }, params: z.object({ type: z.string().regex(/^[a-z0-9_.-]{2,60}$/) }), response: obj,
  async handler(c) {
    const rows = await c.trx('lookup_values as v').join('lookup_types as t', 't.id', 'v.type_id')
      .where('t.key', c.params.type).where('v.active', true)
      .where((w) => w.whereNull('v.organization_id').orWhere('v.organization_id', c.orgId()))
      .orderBy(['v.sort_order', 'v.label']).select('v.id', 'v.code', 'v.label', 'v.sort_order', 'v.organization_id');
    return { data: rows.map((r) => ({ id: r.id, code: r.code, label: r.label, sortOrder: r.sort_order, system: r.organization_id === null })) };
  },
});

defineRoute({
  method: 'post', path: '/lookups/:type/values', module: M, summary: 'Add an organization lookup value',
  access: { permission: 'lookups:create' }, params: z.object({ type: z.string().regex(/^[a-z0-9_.-]{2,60}$/) }),
  body: z.object({ code: z.string().trim().regex(/^[a-z0-9_.-]{1,60}$/), label: z.string().trim().min(1).max(120), sortOrder: z.number().int().default(0) }),
  response: obj, audit: { action: 'lookup.value_created', resourceType: 'lookup_value' },
  async handler(c) {
    let type = await c.trx('lookup_types').where({ key: c.params.type })
      .where((w) => w.whereNull('organization_id').orWhere('organization_id', c.orgId())).first();
    if (!type) {
      const id = newId();
      await c.trx('lookup_types').insert({ id, organization_id: c.orgId(), key: c.params.type, name: c.params.type });
      type = { id };
    }
    const id = newId();
    try {
      await c.trx('lookup_values').insert({ id, organization_id: c.orgId(), type_id: type.id, code: c.body.code, label: c.body.label, sort_order: c.body.sortOrder });
    } catch (e) { throw mapDbError(e); }
    return { status: 201, data: { id, ...c.body } };
  },
});

defineRoute({
  method: 'patch', path: '/lookups/values/:id', module: M, summary: 'Update an organization lookup value',
  access: { permission: 'lookups:update' }, params: z.object({ id: z.string().uuid() }),
  body: z.object({ label: z.string().trim().min(1).max(120).optional(), sortOrder: z.number().int().optional(), active: z.boolean().optional() }),
  response: obj, audit: { action: 'lookup.value_updated', resourceType: 'lookup_value' },
  async handler(c) {
    const patch: Record<string, unknown> = {};
    if (c.body.label !== undefined) patch.label = c.body.label;
    if (c.body.sortOrder !== undefined) patch.sort_order = c.body.sortOrder;
    if (c.body.active !== undefined) patch.active = c.body.active;
    if (Object.keys(patch).length === 0) throw new AppError('VALIDATION_FAILED', 'No fields to update', [{ field: 'body', issue: 'empty' }]);
    const n = await c.trx('lookup_values').where({ id: c.params.id, organization_id: c.orgId() }).update(patch);
    if (!n) throw new AppError('NOT_FOUND', 'Lookup value not found'); // system values are immutable
    return { status: 200, data: { id: c.params.id, ...c.body } };
  },
});

// ---- feature flags + public config ------------------------------------------------------------------------------

defineRoute({
  method: 'get', path: '/feature-flags/evaluate', module: M, summary: 'Feature flags evaluated for the caller',
  access: 'authenticated', scope: 'user', response: obj,
  async handler(c) {
    return { data: await evaluateAll(c.svc.db, { organizationId: c.auth!.organizationId, userId: c.auth!.userId }) };
  },
});

defineRoute({
  method: 'get', path: '/feature-flags', module: M, summary: 'List feature flags (platform admin)', access: 'platformAdmin', response: obj,
  async handler(c) {
    const flags = await c.trx('feature_flags').orderBy('key');
    const ov = await c.trx('feature_flag_overrides');
    return { data: flags.map((f) => ({ ...rowToApi(f), overrides: ov.filter((o) => o.flag_key === f.key).map((o) => rowToApi(o)) })) };
  },
});

defineRoute({
  method: 'put', path: '/feature-flags/:key', module: M, summary: 'Set a flag default and/or an override (platform admin)',
  access: 'platformAdmin', params: z.object({ key: z.string().regex(/^[a-z0-9_.]{3,60}$/) }),
  body: z.object({
    defaultEnabled: z.boolean().optional(),
    override: z.object({ organizationId: z.string().uuid().optional(), userId: z.string().uuid().optional(), enabled: z.boolean() }).optional(),
  }), response: obj,
  async handler(c) {
    const exists = await c.trx('feature_flags').where({ key: c.params.key }).first();
    if (!exists) {
      if (!(MODULE_FLAGS as readonly string[]).includes(c.params.key)) {
        await c.trx('feature_flags').insert({ key: c.params.key, default_enabled: c.body.defaultEnabled ?? false });
      } else throw new AppError('NOT_FOUND', 'Flag not found');
    }
    if (c.body.defaultEnabled !== undefined) {
      await c.trx('feature_flags').where({ key: c.params.key }).update({ default_enabled: c.body.defaultEnabled, updated_at: c.svc.now() });
    }
    if (c.body.override) {
      const { organizationId, userId, enabled } = c.body.override;
      await c.trx('feature_flag_overrides').where({ flag_key: c.params.key })
        .modify((q) => {
          if (organizationId) q.where({ target_org_id: organizationId }); else q.whereNull('target_org_id');
          if (userId) q.where({ user_id: userId }); else q.whereNull('user_id');
        })
        .delete();
      await c.trx('feature_flag_overrides').insert({ id: newId(), flag_key: c.params.key, target_org_id: organizationId ?? null, user_id: userId ?? null, enabled });
    }
    await c.audit({ action: 'feature_flag.changed', resourceType: 'feature_flag', resourceId: c.params.key, metadata: { ...c.body } });
    return { status: 200, data: { key: c.params.key } };
  },
});

defineRoute({
  method: 'get', path: '/config/public', module: M, summary: 'Non-secret client configuration', access: 'public', response: obj,
  async handler(c) {
    const maintenance = await c.trx('application_settings').where({ key: 'maintenance_mode' }).first();
    const flags = await c.trx('feature_flags').select('key', 'default_enabled');
    return {
      status: 200,
      data: {
        apiVersion: 'v1', environment: c.svc.env.NODE_ENV, maintenance: maintenance?.value === true,
        features: Object.fromEntries(flags.map((f) => [f.key, f.default_enabled])),
      },
    };
  },
});

void withPlatformScope;
