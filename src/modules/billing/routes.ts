import { z } from 'zod';
import { defineRoute } from '../../platform/http/route.js';
import { AppError } from '../../platform/errors.js';
import { newId } from '../../platform/crypto.js';
import { rowToApi } from '../../platform/crud.js';
import { loadPlanState } from '../../platform/entitlements.js';
import { providerFor } from '../../platform/payment-provider.js';
import { jobRegistrars } from '../../platform/job-handlers.js';
import { withPlatformScope, withTenant, type Trx } from '../../platform/scope.js';
import { D } from '../../platform/money.js';
import type { Services } from '../../platform/types.js';

const M = 'billing';
const FLAG = 'module.billing';
const obj = z.record(z.string(), z.unknown());
const uuid = z.string().uuid();

/** Documented dunning policy: bounded retries, then read-only restriction, then suspension. */
export const DUNNING = {
  retryAfterDays: [1, 3, 5, 7], // after the failed renewal; max 4 attempts
  restrictAfterDays: 14,
  suspendAfterDays: 30,
} as const;

const periodEnd = (start: Date, interval: string) => {
  const d = new Date(start);
  if (interval === 'year') d.setUTCFullYear(d.getUTCFullYear() + 1);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return d;
};

// ---- plans -----------------------------------------------------------------------------------------------------------

defineRoute({
  method: 'get', path: '/plans', module: M, summary: 'Available plans with entitlements', access: 'public', rateLimit: 'search', response: obj,
  async handler(c) {
    const plans = await c.trx('plans').where({ active: true, public: true }).orderBy('price');
    const ents = await c.trx('plan_entitlements').whereIn('plan_key', plans.map((p) => p.key));
    return {
      status: 200,
      data: plans.map((p) => ({
        key: p.key, name: p.name, description: p.description, price: p.price, currency: p.currency, interval: p.interval, trialDays: p.trial_days,
        entitlements: Object.fromEntries(ents.filter((e) => e.plan_key === p.key).map((e) => [e.feature_key, { enabled: e.enabled, limit: e.limit_value === null ? null : Number(e.limit_value) }])),
      })),
    };
  },
});

// ---- subscription lifecycle -----------------------------------------------------------------------------------------------
// trialing -> active -> past_due -> (active | expired);  active|trialing -> cancelled (immediately or at period end) -> expired

defineRoute({
  method: 'get', path: '/subscriptions/current', module: M, moduleFlag: FLAG, summary: 'Current subscription and entitlements',
  access: { permission: 'billing:read' }, response: obj,
  async handler(c) {
    const plan = await loadPlanState(c.trx, c.orgId());
    const sub = await c.trx('subscriptions').where({ organization_id: c.orgId() }).whereIn('status', ['trialing', 'active', 'past_due']).first();
    const invoices = sub ? await c.trx('subscription_invoices').where({ subscription_id: sub.id }).orderBy('created_at', 'desc').limit(12) : [];
    return {
      data: {
        subscription: sub ? rowToApi(sub) : null, plan: plan.planKey, metered: plan.metered, restricted: plan.restricted,
        entitlements: Object.fromEntries([...plan.entitlements].map(([k, v]) => [k, v])), invoices: invoices.map((i) => rowToApi(i)),
      },
    };
  },
});

async function charge(svc: Services, trx: Trx, sub: Record<string, unknown>, plan: Record<string, unknown>, start: Date, end: Date) {
  const invId = newId();
  await trx('subscription_invoices').insert({
    id: invId, organization_id: sub.organization_id, subscription_id: sub.id, amount: plan.price, currency: plan.currency, period_start: start, period_end: end,
  });
  if (D(plan.price as string).isZero()) {
    await trx('subscription_invoices').where({ id: invId }).update({ status: 'paid', paid_at: svc.now() });
    return true;
  }
  const res = await providerFor(sub.provider as string).charge({
    amount: String(plan.price), currency: plan.currency as string, reference: invId, customerRef: (sub.customer_ref as string) ?? '',
  });
  const ok = res.status === 'succeeded';
  await trx('subscription_invoices').where({ id: invId }).update({ status: ok ? 'paid' : 'failed', paid_at: ok ? svc.now() : null, provider_ref: res.id });
  return ok;
}

defineRoute({
  method: 'post', path: '/subscriptions', module: M, moduleFlag: FLAG, summary: 'Start a trial or subscribe',
  access: { permission: 'billing:manage' }, idempotent: 'required',
  body: z.object({ planKey: z.string().max(40), provider: z.enum(['manual', 'mock']).default('manual'), customerRef: z.string().max(120).optional() }), response: obj,
  audit: { action: 'subscription.started', resourceType: 'subscription' },
  async handler(c) {
    const plan = await c.trx('plans').where({ key: c.body.planKey, active: true }).first();
    if (!plan) throw new AppError('NOT_FOUND', 'Plan not found');
    const live = await c.trx('subscriptions').where({ organization_id: c.orgId() }).whereIn('status', ['trialing', 'active', 'past_due']).first();
    if (live) throw new AppError('CONFLICT', 'The organization already has a subscription; change plan instead');
    const everTrialed = await c.trx('subscriptions').where({ organization_id: c.orgId() }).whereNotNull('trial_end').first();
    const now = c.svc.now();
    const trial = plan.trial_days > 0 && !everTrialed;
    const start = now;
    const end = trial ? new Date(now.getTime() + plan.trial_days * 86400_000) : periodEnd(now, plan.interval);
    const id = newId();
    await c.trx('subscriptions').insert({
      id, organization_id: c.orgId(), plan_key: plan.key, status: trial ? 'trialing' : 'active', current_period_start: start, current_period_end: end,
      trial_end: trial ? end : null, provider: c.body.provider, customer_ref: c.body.customerRef ?? null, created_by: c.auth!.userId, updated_by: c.auth!.userId,
    });
    if (!trial) {
      const sub = await c.trx('subscriptions').where({ id }).first();
      const ok = await charge(c.svc, c.trx, sub, plan, start, end);
      if (!ok) {
        await c.trx('subscriptions').where({ id }).update({ status: 'past_due', past_due_since: now, dunning_attempts: 1, last_attempt_at: now });
      }
    }
    await c.trx('organizations').where({ id: c.orgId() }).update({ plan_key: plan.key });
    await c.emit('subscription.started', { subscriptionId: id, planKey: plan.key });
    return { status: 201, data: rowToApi(await c.trx('subscriptions').where({ id }).first()) };
  },
});

defineRoute({
  method: 'post', path: '/subscriptions/:id/change-plan', module: M, moduleFlag: FLAG, summary: 'Change plan (effective immediately, no proration)',
  access: { permission: 'billing:manage' }, params: z.object({ id: uuid }), body: z.object({ planKey: z.string().max(40) }), idempotent: true, response: obj,
  audit: { action: 'subscription.plan_changed', resourceType: 'subscription' },
  async handler(c) {
    const sub = await c.trx('subscriptions').where({ id: c.params.id, organization_id: c.orgId() }).forUpdate().first();
    if (!sub) throw new AppError('NOT_FOUND', 'Subscription not found');
    if (!['trialing', 'active'].includes(sub.status)) throw new AppError('CONFLICT', `A ${sub.status} subscription cannot change plan`);
    const plan = await c.trx('plans').where({ key: c.body.planKey, active: true }).first();
    if (!plan) throw new AppError('NOT_FOUND', 'Plan not found');
    if (plan.key === sub.plan_key) throw new AppError('CONFLICT', 'Already on this plan');
    await c.trx('subscriptions').where({ id: sub.id }).update({ plan_key: plan.key, updated_at: c.svc.now(), row_version: c.trx.raw('row_version + 1') });
    await c.trx('organizations').where({ id: c.orgId() }).update({ plan_key: plan.key });
    return { status: 200, data: { id: sub.id, planKey: plan.key } };
  },
});

defineRoute({
  method: 'post', path: '/subscriptions/:id/cancel', module: M, moduleFlag: FLAG, summary: 'Cancel (default: at period end)',
  access: { permission: 'billing:manage' }, params: z.object({ id: uuid }), body: z.object({ atPeriodEnd: z.boolean().default(true) }).default({ atPeriodEnd: true }),
  response: obj, audit: { action: 'subscription.cancelled', resourceType: 'subscription' },
  async handler(c) {
    const sub = await c.trx('subscriptions').where({ id: c.params.id, organization_id: c.orgId() }).forUpdate().first();
    if (!sub) throw new AppError('NOT_FOUND', 'Subscription not found');
    if (!['trialing', 'active', 'past_due'].includes(sub.status)) throw new AppError('CONFLICT', `A ${sub.status} subscription cannot be cancelled`);
    const atEnd = (c.body as { atPeriodEnd: boolean }).atPeriodEnd;
    if (atEnd) {
      await c.trx('subscriptions').where({ id: sub.id }).update({ cancel_at_period_end: true, updated_at: c.svc.now() });
      return { status: 200, data: { id: sub.id, status: sub.status, cancelAtPeriodEnd: true } };
    }
    await c.trx('subscriptions').where({ id: sub.id }).update({ status: 'cancelled', cancelled_at: c.svc.now(), updated_at: c.svc.now(), restricted: false });
    await c.trx('organizations').where({ id: c.orgId() }).update({ plan_key: 'free' });
    return { status: 200, data: { id: sub.id, status: 'cancelled' } };
  },
});

defineRoute({
  method: 'post', path: '/subscriptions/:id/reactivate', module: M, moduleFlag: FLAG, summary: 'Undo a pending cancellation',
  access: { permission: 'billing:manage' }, params: z.object({ id: uuid }), response: obj, audit: { action: 'subscription.reactivated', resourceType: 'subscription' },
  async handler(c) {
    const sub = await c.trx('subscriptions').where({ id: c.params.id, organization_id: c.orgId() }).forUpdate().first();
    if (!sub) throw new AppError('NOT_FOUND', 'Subscription not found');
    if (!sub.cancel_at_period_end || !['trialing', 'active'].includes(sub.status)) throw new AppError('CONFLICT', 'Nothing to reactivate');
    await c.trx('subscriptions').where({ id: sub.id }).update({ cancel_at_period_end: false, updated_at: c.svc.now() });
    return { status: 200, data: { id: sub.id, cancelAtPeriodEnd: false } };
  },
});

// ---- usage metering (F-257) ---------------------------------------------------------------------------------------------------

defineRoute({
  method: 'post', path: '/usage/events', module: M, moduleFlag: FLAG, summary: 'Ingest a usage event (idempotent by eventId)',
  access: { permission: 'billing:manage' }, body: z.object({ metric: z.string().regex(/^[a-z][a-z0-9_.]{1,60}$/), quantity: z.number().min(0).max(1e9), eventId: z.string().min(1).max(120), occurredAt: z.string().datetime().optional() }),
  response: obj,
  async handler(c) {
    const sub = await c.trx('subscriptions').where({ organization_id: c.orgId() }).whereIn('status', ['trialing', 'active', 'past_due']).first();
    const ins = await c.trx('usage_records').insert({
      id: newId(), organization_id: c.orgId(), subscription_id: sub?.id ?? null, metric: c.body.metric, quantity: c.body.quantity,
      event_id: c.body.eventId, occurred_at: c.body.occurredAt ?? c.svc.now(),
    }).onConflict(['organization_id', 'metric', 'event_id']).ignore().returning('id');
    return { status: ins.length ? 201 : 200, data: { recorded: ins.length > 0, duplicate: ins.length === 0 } };
  },
});

defineRoute({
  method: 'get', path: '/usage', module: M, moduleFlag: FLAG, summary: 'Usage totals for a period',
  access: { permission: 'billing:read' }, query: z.object({ from: z.string().datetime().optional(), to: z.string().datetime().optional() }), response: obj,
  async handler(c) {
    const to = c.query.to ? new Date(c.query.to) : c.svc.now();
    const from = c.query.from ? new Date(c.query.from) : new Date(to.getTime() - 30 * 86400_000);
    const rows = (await c.trx('usage_records').where({ organization_id: c.orgId() }).whereBetween('occurred_at', [from, to])
      .select('metric').sum({ total: 'quantity' }).count({ events: '*' }).groupBy('metric')) as unknown as { metric: string; total: string; events: string }[];
    return { data: { from: from.toISOString(), to: to.toISOString(), metrics: rows.map((r) => ({ metric: r.metric, total: r.total, events: Number(r.events) })) } };
  },
});

defineRoute({
  method: 'get', path: '/entitlements/:key', module: M, moduleFlag: FLAG, summary: 'Check one entitlement',
  access: 'authenticated', params: z.object({ key: z.string().max(60) }), response: obj,
  async handler(c) {
    const plan = await loadPlanState(c.trx, c.orgId());
    const e = plan.entitlements.get(c.params.key);
    return { data: { key: c.params.key, plan: plan.planKey, metered: plan.metered, enabled: !plan.metered || !!e?.enabled, limit: e?.limit ?? null, restricted: plan.restricted } };
  },
});

// ---- provider webhooks (verified + idempotent inbox) -----------------------------------------------------------------------------

defineRoute({
  method: 'post', path: '/billing/webhooks/:provider', module: M, summary: 'Payment provider webhook (signature verified)',
  access: 'public', rateLimit: 'apikey', params: z.object({ provider: z.enum(['mock']) }), body: z.record(z.string(), z.unknown()), response: obj,
  async handler(c) {
    const raw = (c.req as unknown as { rawBody?: Buffer }).rawBody?.toString('utf8') ?? JSON.stringify(c.body);
    const ev = providerFor(c.params.provider).verifyWebhook(raw, c.req.get('x-signature') ?? undefined);
    if (!ev) throw new AppError('UNAUTHENTICATED', 'Invalid signature');
    const ins = await c.trx('billing_events').insert({
      id: newId(), provider: c.params.provider, event_id: ev.id, type: ev.type, payload: JSON.stringify(ev),
    }).onConflict(['provider', 'event_id']).ignore().returning('id');
    if (ins.length === 0) return { status: 200, data: { received: true, duplicate: true } };
    // reference = subscription invoice id
    const inv = await c.trx('subscription_invoices').where({ id: ev.reference }).first();
    let outcome = 'ignored';
    if (inv) {
      const sub = await c.trx('subscriptions').where({ id: inv.subscription_id }).forUpdate().first();
      if (ev.type === 'payment.succeeded' && sub) {
        await c.trx('subscription_invoices').where({ id: inv.id }).update({ status: 'paid', paid_at: c.svc.now() });
        await c.trx('subscriptions').where({ id: sub.id }).update({
          status: 'active', past_due_since: null, dunning_attempts: 0, restricted: false, updated_at: c.svc.now(),
        });
        await c.trx('organizations').where({ id: sub.organization_id, status: 'suspended' }).update({ status: 'active', suspended_reason: null });
        outcome = 'activated';
      } else if (ev.type === 'payment.failed' && sub && sub.status !== 'past_due') {
        await c.trx('subscription_invoices').where({ id: inv.id }).update({ status: 'failed' });
        await c.trx('subscriptions').where({ id: sub.id }).update({ status: 'past_due', past_due_since: c.svc.now(), dunning_attempts: sub.dunning_attempts + 1, updated_at: c.svc.now() });
        outcome = 'past_due';
      }
    }
    await c.trx('billing_events').where({ provider: c.params.provider, event_id: ev.id }).update({ processed_at: c.svc.now(), outcome });
    return { status: 200, data: { received: true, outcome } };
  },
});

// ---- renewal + dunning jobs (idempotent) ----------------------------------------------------------------------------------------

export async function runBilling(svc: Services): Promise<{ renewed: number; failed: number; retried: number; restricted: number; suspended: number; expired: number }> {
  const now = svc.now();
  const out = { renewed: 0, failed: 0, retried: 0, restricted: 0, suspended: 0, expired: 0 };
  const dueRenewals = await withPlatformScope(svc.db, 'billing-renewals', (t) =>
    t('subscriptions').whereIn('status', ['trialing', 'active']).where('current_period_end', '<=', now).select('id', 'organization_id'));
  for (const s of dueRenewals) {
    await withTenant(svc.db, { organizationId: s.organization_id, userId: null }, async (trx) => {
      const sub = await trx('subscriptions').where({ id: s.id }).forUpdate().first();
      if (!sub || !['trialing', 'active'].includes(sub.status) || new Date(sub.current_period_end) > now) return; // already handled
      if (sub.cancel_at_period_end) {
        await trx('subscriptions').where({ id: sub.id }).update({ status: 'expired', updated_at: now });
        await trx('organizations').where({ id: sub.organization_id }).update({ plan_key: 'free' });
        out.expired++;
        return;
      }
      const plan = await trx('plans').where({ key: sub.plan_key }).first();
      const start = new Date(sub.current_period_end);
      const end = periodEnd(start, plan.interval);
      const ok = await charge(svc, trx, sub, plan, start, end);
      if (ok) {
        await trx('subscriptions').where({ id: sub.id }).update({ status: 'active', current_period_start: start, current_period_end: end, updated_at: now });
        out.renewed++;
      } else {
        await trx('subscriptions').where({ id: sub.id }).update({ status: 'past_due', past_due_since: now, dunning_attempts: 1, last_attempt_at: now, current_period_start: start, current_period_end: end });
        await svc.events.emit(trx, 'subscription.payment_failed', sub.organization_id, { subscriptionId: sub.id });
        out.failed++;
      }
    });
  }

  const pastDue = await withPlatformScope(svc.db, 'billing-dunning', (t) => t('subscriptions').where({ status: 'past_due' }).select('id', 'organization_id'));
  for (const s of pastDue) {
    await withTenant(svc.db, { organizationId: s.organization_id, userId: null }, async (trx) => {
      const sub = await trx('subscriptions').where({ id: s.id }).forUpdate().first();
      if (!sub || sub.status !== 'past_due' || !sub.past_due_since) return;
      const days = (now.getTime() - new Date(sub.past_due_since).getTime()) / 86400_000;
      if (days >= DUNNING.suspendAfterDays) {
        await trx('subscriptions').where({ id: sub.id }).update({ status: 'expired', restricted: true, updated_at: now });
        await trx('organizations').where({ id: sub.organization_id, status: 'active' }).update({ status: 'suspended', suspended_reason: 'subscription unpaid', updated_at: now });
        out.suspended++;
        return;
      }
      if (days >= DUNNING.restrictAfterDays && !sub.restricted) {
        await trx('subscriptions').where({ id: sub.id }).update({ restricted: true, updated_at: now });
        out.restricted++;
      }
      const nextIdx = sub.dunning_attempts - 1; // attempts already made beyond the first failure
      const wait = DUNNING.retryAfterDays[nextIdx];
      if (wait !== undefined && days >= wait && (!sub.last_attempt_at || new Date(sub.last_attempt_at) < new Date(now.getTime() - 3600_000))) {
        const plan = await trx('plans').where({ key: sub.plan_key }).first();
        const ok = await charge(svc, trx, sub, plan, new Date(sub.current_period_start), new Date(sub.current_period_end));
        if (ok) {
          await trx('subscriptions').where({ id: sub.id }).update({ status: 'active', past_due_since: null, dunning_attempts: 0, restricted: false, last_attempt_at: now, updated_at: now });
          out.retried++;
        } else {
          await trx('subscriptions').where({ id: sub.id }).update({ dunning_attempts: sub.dunning_attempts + 1, last_attempt_at: now });
        }
      }
    });
  }
  return out;
}

jobRegistrars.push((svc) => { svc.jobs.work('billing', async () => { await runBilling(svc); }); });
