import { z } from 'zod';
import { documentRoutes, uuid, isoDate } from '../../platform/openapi/document.js';
import { rowOf } from '../../platform/openapi/rows.js';

const subscription = rowOf('subscriptions', { describe: { status: '`trialing`, `active`, `past_due`, `cancelled` or `expired`.', cancelAtPeriodEnd: 'Cancellation is pending at the period end.' } });

documentRoutes({
  listPlans: {
    collection: true, responseName: 'Plan', successStatus: 200,
    response: z.object({
      key: z.string().describe('Plan key, e.g. `starter`.'), name: z.string().describe('Plan name.'), description: z.string().nullable().describe('Marketing description.'),
      price: z.string().describe('Price per interval (decimal string).'), currency: z.string().describe('Currency.'), interval: z.string().describe('`month` or `year`.'),
      trialDays: z.number().int().describe('Free trial length.'),
      entitlements: z.record(z.string(), z.object({ enabled: z.boolean().describe('Feature on/off.'), limit: z.number().nullable().describe('Numeric cap; `null` = unlimited.') })).describe('Feature key → entitlement.'),
    }),
    description: 'Public plan catalog with entitlements. No authentication.',
  },
  getCurrentSubscription: {
    response: z.object({
      subscription: subscription.nullable().describe('Active subscription; `null` when none (unmetered organization).'),
      plan: z.string().nullable().describe('Plan key.'), metered: z.boolean().describe('`false` = no plan limits apply.'), restricted: z.boolean().describe('`true` when the account is restricted (past due/expired).'),
      entitlements: z.record(z.string(), z.unknown()).describe('Feature key → `{ enabled, limit }`.'),
      invoices: z.array(rowOf('subscription_invoices')).describe('The 12 most recent subscription invoices.'),
    }),
    responseName: 'CurrentSubscription', description: 'Plan state of the active organization: subscription, entitlements and recent charges.',
  },
  createSubscription: {
    successStatus: 201, response: subscription, responseName: 'Subscription', errors: [409],
    description: 'Starts a trial or subscribes to a plan. `Idempotency-Key` is supported. One live subscription per organization (`409`).',
  },
  changeSubscriptionPlan: {
    successStatus: 200, response: z.object({ id: uuid.describe('Subscription id.'), planKey: z.string().describe('New plan.') }), errors: [409],
    description: 'Changes plan effective immediately, without proration. `Idempotency-Key` is supported.',
  },
  cancelSubscription: {
    successStatus: 200, response: z.object({ id: uuid.describe('Subscription id.'), status: z.string().describe('Status after the call.'), cancelAtPeriodEnd: z.boolean().optional().describe('`true` when cancellation is scheduled for the period end.') }),
    description: 'Cancels at period end by default; `immediately=true` cancels now.',
  },
  reactivateSubscription: { successStatus: 200, response: z.object({ id: uuid.describe('Subscription id.'), cancelAtPeriodEnd: z.literal(false).describe('Cancellation removed.') }), errors: [409], description: 'Undoes a pending cancellation.' },
  ingestUsageEvent: {
    successStatus: [200, 201], response: z.object({ recorded: z.boolean().describe('`true` when newly stored.'), duplicate: z.boolean().describe('`true` when `eventId` was already recorded (no double counting).') }),
    description: 'Records one metered usage event; idempotent by `eventId` (`201` new, `200` duplicate).',
  },
  getUsageSummary: {
    response: z.object({ from: isoDate.describe('Range start.'), to: isoDate.describe('Range end.'), metrics: z.array(z.object({ metric: z.string().describe('Metric name.'), total: z.string().describe('Summed quantity.'), events: z.number().int().describe('Events counted.') })).describe('Totals per metric.') }),
    responseName: 'UsageSummary', description: 'Usage totals per metric for the period (default: current billing period).',
  },
  getEntitlementByKey: {
    response: z.object({ key: z.string().describe('Entitlement key, e.g. `max_projects`.'), plan: z.string().nullable().describe('Plan key.'), metered: z.boolean().describe('Whether plan limits apply.'), enabled: z.boolean().describe('Feature available.'), limit: z.number().nullable().describe('Numeric cap or `null`.'), restricted: z.boolean().describe('Account restricted.') }),
    responseName: 'Entitlement', description: 'Check one feature or limit, e.g. before showing an upgrade prompt.',
  },
  receiveBillingWebhook: {
    successStatus: 200, errors: [401], response: z.object({ received: z.literal(true).describe('Acknowledged.'), duplicate: z.boolean().optional().describe('Already processed.'), outcome: z.string().optional().describe('What was done.') }),
    description: 'Inbound webhook for the payment provider (internal). The signature header is verified; events are de-duplicated.',
  },
});
