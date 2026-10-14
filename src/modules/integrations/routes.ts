import { z } from 'zod';
import { defineRoute } from '../../platform/http/route.js';
import { AppError } from '../../platform/errors.js';
import { decrypt, encrypt, hmac, newId, randomToken, safeEqual } from '../../platform/crypto.js';
import { rowToApi, mapDbError } from '../../platform/crud.js';
import { paginate, listQuerySchema, type ListQuery } from '../../platform/pagination.js';
import { assertSafeOutboundUrl } from '../../platform/ssrf.js';
import { jobRegistrars } from '../../platform/job-handlers.js';
import { isFlagEnabled } from '../../platform/flags.js';
import { withPlatformScope, withTenant, type Trx } from '../../platform/scope.js';
import { EVENT_RULES } from '../notifications/routes.js';
import type { DomainEvent } from '../../platform/events.js';
import type { Services } from '../../platform/types.js';

const M = 'integrations';
const FLAG = 'module.integrations';
const obj = z.record(z.string(), z.unknown());
const uuid = z.string().uuid();
const idParams = z.object({ id: uuid });

export const MAX_ATTEMPTS = 6;
export const AUTO_DISABLE_AFTER = 20;
const BACKOFF_SECONDS = [30, 120, 600, 3600, 21600];

/** Events that may be delivered to webhooks (catalog is explicit: internal events are never leaked). */
export const WEBHOOK_EVENTS = [
  'task.created', 'task.assigned', 'task.status_changed', 'projects.created', 'projects.updated',
  'approval.requested', 'approval.approved', 'approval.rejected', 'timesheet.submitted', 'timesheet.approved', 'timesheet.rejected',
  'invoice.sent', 'invoice.overdue', 'payment.recorded', 'user.removed', 'invitation.created', 'file.uploaded',
  ...Object.keys(EVENT_RULES),
];
const CATALOG = [...new Set(WEBHOOK_EVENTS)].sort();
const isWebhookEvent = (t: string) => CATALOG.includes(t) || /^[a-z_]+.(created|updated|deleted)$/.test(t);

// ---- signing (F-231) ---------------------------------------------------------------------------------------------------

export function signPayload(secret: string, body: string, ts: number): string {
  return `t=${ts},v1=${hmac(secret, `${ts}.${body}`)}`;
}

/** Receiver-side helper (also used for inbound provider webhooks): constant-time compare + timestamp tolerance. */
export function verifySignature(secret: string, header: string, body: string, toleranceSeconds = 300, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=') as [string, string]));
  const ts = Number(parts.t);
  if (!parts.v1 || Number.isNaN(ts) || Math.abs(nowSeconds - ts) > toleranceSeconds) return false;
  return safeEqual(hmac(secret, `${ts}.${body}`), parts.v1);
}

// ---- endpoint management -------------------------------------------------------------------------------------------------

const newSecret = () => `whsec_${randomToken(32)}`;
const eventTypes = z.array(z.string().max(60)).min(1).max(50).default(['*']).refine((a) => a.every((e: string) => e === '*' || isWebhookEvent(e)), 'unknown event type');

async function urlCheck(svc: Services, url: string) {
  try {
    await assertSafeOutboundUrl(url, { requireHttps: svc.env.OUTBOUND_REQUIRE_HTTPS ?? svc.env.NODE_ENV === 'production', resolver: svc.resolver });
  } catch (e) {
    throw new AppError('VALIDATION_FAILED', 'Webhook URL is not allowed', [{ field: 'url', issue: (e as Error).message }]);
  }
}

defineRoute({
  method: 'get', path: '/webhook-events/catalog', module: M, moduleFlag: FLAG, summary: 'Event catalog', access: { permission: 'webhooks:read' }, response: obj,
  async handler() { return { data: CATALOG }; },
});

defineRoute({
  method: 'post', path: '/webhook-endpoints', module: M, moduleFlag: FLAG, summary: 'Create a webhook endpoint (secret shown once)',
  access: { permission: 'webhooks:create' }, entitlement: { key: 'webhooks' }, rateLimit: 'apikey',
  body: z.object({ url: z.string().url().max(500), description: z.string().max(200).default(''), eventTypes }), response: obj,
  audit: { action: 'webhook_endpoint.created', resourceType: 'webhook_endpoint' },
  async handler(c) {
    await urlCheck(c.svc, c.body.url);
    const secret = newSecret();
    const id = newId();
    await c.trx('webhook_endpoints').insert({
      id, organization_id: c.orgId(), url: c.body.url, description: c.body.description, secret_encrypted: encrypt(c.svc.keys, secret),
      event_types: c.body.eventTypes, created_by: c.auth!.userId, updated_by: c.auth!.userId,
    });
    return { status: 201, data: { id, url: c.body.url, eventTypes: c.body.eventTypes, secret } };
  },
});

const epDto = (r: Record<string, unknown>) => rowToApi(r, ['secret_encrypted', 'previous_secret_encrypted', 'previous_secret_expires_at']);

defineRoute({
  method: 'get', path: '/webhook-endpoints', module: M, moduleFlag: FLAG, summary: 'List endpoints (secrets never returned)',
  access: { permission: 'webhooks:read' }, response: obj,
  async handler(c) {
    return { data: (await c.trx('webhook_endpoints').where({ organization_id: c.orgId() }).orderBy('created_at', 'desc')).map(epDto) };
  },
});

defineRoute({
  method: 'patch', path: '/webhook-endpoints/:id', module: M, moduleFlag: FLAG, summary: 'Update an endpoint',
  access: { permission: 'webhooks:update' }, params: idParams,
  body: z.object({ url: z.string().url().max(500).optional(), description: z.string().max(200).optional(), eventTypes: eventTypes.optional(), status: z.enum(['active', 'disabled']).optional() }),
  response: obj, audit: { action: 'webhook_endpoint.updated', resourceType: 'webhook_endpoint' },
  async handler(c) {
    if (c.body.url) await urlCheck(c.svc, c.body.url);
    const patch: Record<string, unknown> = { updated_at: c.svc.now(), updated_by: c.auth!.userId, row_version: c.trx.raw('row_version + 1') };
    if (c.body.url) patch.url = c.body.url;
    if (c.body.description !== undefined) patch.description = c.body.description;
    if (c.body.eventTypes) patch.event_types = c.body.eventTypes;
    if (c.body.status) { patch.status = c.body.status; if (c.body.status === 'active') { patch.consecutive_failures = 0; patch.disabled_reason = null; } }
    const n = await c.trx('webhook_endpoints').where({ id: c.params.id, organization_id: c.orgId() }).update(patch);
    if (!n) throw new AppError('NOT_FOUND', 'Endpoint not found');
    return { status: 200, data: epDto(await c.trx('webhook_endpoints').where({ id: c.params.id }).first()) };
  },
});

defineRoute({
  method: 'delete', path: '/webhook-endpoints/:id', module: M, moduleFlag: FLAG, summary: 'Delete an endpoint',
  access: { permission: 'webhooks:delete' }, params: idParams, audit: { action: 'webhook_endpoint.deleted', resourceType: 'webhook_endpoint' },
  async handler(c) {
    const n = await c.trx('webhook_endpoints').where({ id: c.params.id, organization_id: c.orgId() }).delete();
    if (!n) throw new AppError('NOT_FOUND', 'Endpoint not found');
    return { status: 204, auditResourceId: c.params.id };
  },
});

defineRoute({
  method: 'post', path: '/webhook-endpoints/:id/rotate-secret', module: M, moduleFlag: FLAG, summary: 'Rotate the signing secret with an overlap window',
  access: { permission: 'webhooks:update' }, params: idParams, body: z.object({ overlapMinutes: z.number().int().min(0).max(1440).default(60) }).default({ overlapMinutes: 60 }),
  response: obj, audit: { action: 'webhook_endpoint.secret_rotated', resourceType: 'webhook_endpoint' },
  async handler(c) {
    const ep = await c.trx('webhook_endpoints').where({ id: c.params.id, organization_id: c.orgId() }).forUpdate().first();
    if (!ep) throw new AppError('NOT_FOUND', 'Endpoint not found');
    const secret = newSecret();
    const overlap = (c.body as { overlapMinutes: number }).overlapMinutes;
    await c.trx('webhook_endpoints').where({ id: ep.id }).update({
      secret_encrypted: encrypt(c.svc.keys, secret), previous_secret_encrypted: ep.secret_encrypted,
      previous_secret_expires_at: new Date(c.svc.now().getTime() + overlap * 60_000), updated_at: c.svc.now(),
    });
    return { status: 200, data: { id: ep.id, secret, previousSecretValidForMinutes: overlap } };
  },
});

// ---- dispatch --------------------------------------------------------------------------------------------------------------

async function createDeliveries(svc: Services, trx: Trx, orgId: string, eventId: string, type: string, payload: Record<string, unknown>, onlyEndpoint?: string) {
  const eps = await trx('webhook_endpoints').where({ organization_id: orgId, status: 'active' }).modify((q) => { if (onlyEndpoint) q.where({ id: onlyEndpoint }); });
  const matched = eps.filter((e: Record<string, unknown>) => (e.event_types as string[]).includes('*') || (e.event_types as string[]).includes(type));
  if (matched.length === 0) return [];
  await trx('webhook_events').insert({ id: eventId, organization_id: orgId, type, payload: JSON.stringify(payload) }).onConflict('id').ignore();
  const ids: string[] = [];
  for (const ep of matched) {
    const id = newId();
    await trx('webhook_deliveries').insert({ id, organization_id: orgId, endpoint_id: ep.id, event_id: eventId });
    ids.push(id);
  }
  return ids;
}

/** Performs one delivery attempt. Never throws for HTTP failures: state is recorded and retries are scheduled. */
export async function attemptDelivery(svc: Services, orgId: string, deliveryId: string): Promise<{ result: 'delivered' | 'retry' | 'dead' | 'skipped'; waitSeconds?: number }> {
  return withTenant(svc.db, { organizationId: orgId, userId: null }, async (trx) => {
    const d = await trx('webhook_deliveries').where({ id: deliveryId }).forUpdate().first();
    if (!d || d.status === 'delivered' || d.status === 'dead') return { result: 'skipped' as const };
    const ep = await trx('webhook_endpoints').where({ id: d.endpoint_id }).first();
    const ev = await trx('webhook_events').where({ id: d.event_id }).first();
    if (!ep || !ev || ep.status !== 'active') {
      await trx('webhook_deliveries').where({ id: d.id }).update({ status: 'dead', error_summary: 'endpoint disabled or removed' });
      return { result: 'dead' as const };
    }
    const attempt = d.attempt + 1;
    const body = JSON.stringify({ id: ev.id, type: ev.type, createdAt: new Date(ev.created_at).toISOString(), data: ev.payload });
    const ts = Math.floor(svc.now().getTime() / 1000);
    const secret = decrypt(svc.keys, ep.secret_encrypted);
    const sigs = [signPayload(secret, body, ts)];
    if (ep.previous_secret_encrypted && ep.previous_secret_expires_at && new Date(ep.previous_secret_expires_at) > svc.now()) {
      sigs.push(signPayload(decrypt(svc.keys, ep.previous_secret_encrypted), body, ts)); // receivers may validate either during rotation
    }
    let status: number | null = null;
    let err: string | null = null;
    try {
      const u = await assertSafeOutboundUrl(ep.url, { requireHttps: svc.env.OUTBOUND_REQUIRE_HTTPS ?? svc.env.NODE_ENV === 'production', resolver: svc.resolver });
      const res = await (svc.fetch ?? fetch)(u.toString(), {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10_000),
        headers: { 'content-type': 'application/json', 'user-agent': 'Zellavora-Nexus-Webhooks/1', 'x-nexus-event': ev.type, 'x-nexus-delivery': d.id, 'x-nexus-signature': sigs.join(' ') },
        body,
      });
      status = res.status;
      if (status < 200 || status >= 300) err = `HTTP ${status}`;
    } catch (e) {
      err = (e as Error).message.slice(0, 200);
    }
    if (!err) {
      await trx('webhook_deliveries').where({ id: d.id }).update({ status: 'delivered', attempt, response_status: status, last_attempt_at: svc.now(), error_summary: null, next_attempt_at: null });
      await trx('webhook_endpoints').where({ id: ep.id }).update({ consecutive_failures: 0 });
      return { result: 'delivered' as const };
    }
    const dead = attempt >= MAX_ATTEMPTS;
    const wait = BACKOFF_SECONDS[Math.min(attempt - 1, BACKOFF_SECONDS.length - 1)]!;
    await trx('webhook_deliveries').where({ id: d.id }).update({
      status: dead ? 'dead' : 'failed', attempt, response_status: status, error_summary: err, last_attempt_at: svc.now(),
      next_attempt_at: dead ? null : new Date(svc.now().getTime() + wait * 1000),
    });
    const fails = ep.consecutive_failures + 1;
    await trx('webhook_endpoints').where({ id: ep.id }).update(
      fails >= AUTO_DISABLE_AFTER
        ? { consecutive_failures: fails, status: 'disabled', disabled_reason: `auto-disabled after ${fails} consecutive failures` }
        : { consecutive_failures: fails });
    // the retry is scheduled by the worker AFTER this transaction commits (never inside it)
    return dead ? { result: 'dead' as const } : { result: 'retry' as const, waitSeconds: wait };
  });
}

jobRegistrars.push((svc) => {
  svc.events.on('*', async (e: DomainEvent) => {
    if (!e.organizationId || !isWebhookEvent(e.type)) return;
    if (!(await isFlagEnabled(svc.db, FLAG, { organizationId: e.organizationId }))) return;
    const ids = await withTenant(svc.db, { organizationId: e.organizationId, userId: null }, (trx) =>
      createDeliveries(svc, trx, e.organizationId!, e.id, e.type, e.payload));
    for (const deliveryId of ids) await svc.jobs.enqueue('webhooks', { organizationId: e.organizationId, deliveryId });
  });
  svc.jobs.work('webhooks', async (d) => {
    const r = await attemptDelivery(svc, d.organizationId as string, d.deliveryId as string);
    if (r.result === 'retry') await svc.jobs.enqueue('webhooks', { organizationId: d.organizationId, deliveryId: d.deliveryId }, { startAfterSeconds: r.waitSeconds });
  });
});

defineRoute({
  method: 'post', path: '/webhook-endpoints/:id/test', module: M, moduleFlag: FLAG, summary: 'Send a test ping',
  access: { permission: 'webhooks:update' }, params: idParams, rateLimit: 'apikey', response: obj,
  async handler(c) {
    const ep = await c.trx('webhook_endpoints').where({ id: c.params.id, organization_id: c.orgId() }).first();
    if (!ep) throw new AppError('NOT_FOUND', 'Endpoint not found');
    const eventId = newId();
    await c.trx('webhook_events').insert({ id: eventId, organization_id: c.orgId(), type: 'webhook.ping', payload: JSON.stringify({ message: 'ping' }) });
    const id = newId();
    await c.trx('webhook_deliveries').insert({ id, organization_id: c.orgId(), endpoint_id: ep.id, event_id: eventId });
    await c.emit('webhook.test_requested', { deliveryId: id });
    return { status: 202, data: { deliveryId: id } };
  },
});

jobRegistrars.push((svc) => {
  svc.events.on('webhook.test_requested', async (e) => {
    await svc.jobs.enqueue('webhooks', { organizationId: e.organizationId, deliveryId: e.payload.deliveryId as string });
  });
});

// ---- history, retry, replay (F-135, F-136, F-234) ---------------------------------------------------------------------------

defineRoute({
  method: 'get', path: '/webhook-deliveries', module: M, moduleFlag: FLAG, summary: 'Delivery history with filters',
  access: { permission: 'webhooks:read' }, query: listQuerySchema.extend({ endpointId: uuid.optional() }), response: obj,
  async handler(c) {
    const q = c.query as { endpointId?: string } & ListQuery;
    const qb = c.trx('webhook_deliveries as d').join('webhook_events as e', 'e.id', 'd.event_id').where('d.organization_id', c.orgId())
      .select('d.id', 'd.endpoint_id', 'd.event_id', 'e.type', 'd.status', 'd.attempt', 'd.response_status', 'd.error_summary', 'd.last_attempt_at', 'd.next_attempt_at', 'd.created_at');
    if (q.endpointId) qb.where('d.endpoint_id', q.endpointId);
    const page = await paginate(qb, q, { sortable: { created_at: 'd.created_at' }, filterable: { status: 'd.status', type: 'e.type' }, defaultSort: '-created_at', idColumn: 'd.id' });
    return { data: page.data.map((r) => rowToApi(r)), meta: page.meta };
  },
});

defineRoute({
  method: 'get', path: '/webhook-events', module: M, moduleFlag: FLAG, summary: 'Event history', access: { permission: 'webhooks:read' },
  query: listQuerySchema, response: obj,
  async handler(c) {
    const page = await paginate(c.trx('webhook_events').where({ organization_id: c.orgId() }), c.query as ListQuery, {
      sortable: { created_at: 'created_at' }, filterable: { type: 'type' }, defaultSort: '-created_at',
    });
    return { data: page.data.map((r) => rowToApi(r)), meta: page.meta };
  },
});

defineRoute({
  method: 'post', path: '/webhook-deliveries/:id/retry', module: M, moduleFlag: FLAG, summary: 'Retry a failed or dead delivery',
  access: { permission: 'webhooks:update' }, params: idParams, response: obj, audit: { action: 'webhook_delivery.retried', resourceType: 'webhook_delivery' },
  async handler(c) {
    const d = await c.trx('webhook_deliveries').where({ id: c.params.id, organization_id: c.orgId() }).first();
    if (!d) throw new AppError('NOT_FOUND', 'Delivery not found');
    if (d.status === 'delivered' || d.status === 'pending') throw new AppError('CONFLICT', `A ${d.status} delivery cannot be retried`);
    await c.trx('webhook_deliveries').where({ id: d.id }).update({ status: 'pending', attempt: 0, next_attempt_at: null });
    await c.trx('webhook_endpoints').where({ id: d.endpoint_id, status: 'disabled' }).update({ status: 'active', consecutive_failures: 0, disabled_reason: null });
    await c.emit('webhook.test_requested', { deliveryId: d.id });
    return { status: 202, data: { id: d.id, status: 'pending' } };
  },
});

defineRoute({
  method: 'post', path: '/webhook-events/:id/replay', module: M, moduleFlag: FLAG, summary: 'Replay an event to current endpoints',
  access: { permission: 'webhooks:update' }, params: idParams, body: z.object({ endpointId: uuid.optional() }).default({}), response: obj,
  audit: { action: 'webhook_event.replayed', resourceType: 'webhook_event' },
  async handler(c) {
    const ev = await c.trx('webhook_events').where({ id: c.params.id, organization_id: c.orgId() }).first();
    if (!ev) throw new AppError('NOT_FOUND', 'Event not found');
    const eps = await c.trx('webhook_endpoints').where({ organization_id: c.orgId(), status: 'active' })
      .modify((q) => { const only = (c.body as { endpointId?: string }).endpointId; if (only) q.where({ id: only }); });
    const ids: string[] = [];
    for (const ep of eps) {
      if (!(ep.event_types as string[]).includes('*') && !(ep.event_types as string[]).includes(ev.type)) continue;
      const id = newId();
      await c.trx('webhook_deliveries').insert({ id, organization_id: c.orgId(), endpoint_id: ep.id, event_id: ev.id });
      ids.push(id);
      await c.emit('webhook.test_requested', { deliveryId: id });
    }
    return { status: 202, data: { eventId: ev.id, deliveries: ids } };
  },
});

// ---- integration configs (secrets encrypted, never returned) -----------------------------------------------------------------

defineRoute({
  method: 'put', path: '/integrations/:provider', module: M, moduleFlag: FLAG, summary: 'Save an integration configuration',
  access: { permission: 'integrations:update' }, params: z.object({ provider: z.string().regex(/^[a-z][a-z0-9_-]{1,40}$/) }),
  body: z.object({ name: z.string().max(60).default('default'), config: z.record(z.string(), z.string().max(2000)), status: z.enum(['active', 'disabled']).default('active') }),
  response: obj, audit: { action: 'integration.configured', resourceType: 'integration' },
  async handler(c) {
    const enc = encrypt(c.svc.keys, JSON.stringify(c.body.config));
    try {
      await c.trx('integration_configs').insert({
        id: newId(), organization_id: c.orgId(), provider: c.params.provider, name: c.body.name, config_encrypted: enc, status: c.body.status,
        created_by: c.auth!.userId, updated_by: c.auth!.userId,
      }).onConflict(['organization_id', 'provider', 'name']).merge({ config_encrypted: enc, status: c.body.status, updated_at: c.svc.now(), updated_by: c.auth!.userId });
    } catch (e) { throw mapDbError(e); }
    return { status: 200, data: { provider: c.params.provider, name: c.body.name, keys: Object.keys(c.body.config), status: c.body.status } };
  },
});

defineRoute({
  method: 'get', path: '/integrations', module: M, moduleFlag: FLAG, summary: 'List integrations (values masked)',
  access: { permission: 'integrations:read' }, response: obj,
  async handler(c) {
    const rows = await c.trx('integration_configs').where({ organization_id: c.orgId() }).orderBy('provider');
    return {
      data: rows.map((r) => {
        const cfg = JSON.parse(decrypt(c.svc.keys, r.config_encrypted)) as Record<string, string>;
        return { id: r.id, provider: r.provider, name: r.name, status: r.status, config: Object.fromEntries(Object.keys(cfg).map((k) => [k, '********'])) };
      }),
    };
  },
});

void withPlatformScope;
