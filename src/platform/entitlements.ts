import { AppError } from './errors.js';
import { isFlagEnabled } from './flags.js';
import type { Trx } from './scope.js';

export interface EntitlementSpec {
  key: string;
  count?: (c: { trx: Trx; orgId: string }) => Promise<number>;
}

export interface PlanState {
  planKey: string;
  restricted: boolean;
  /** false when no plan/subscription is assigned: such organizations are unmetered. */
  metered: boolean;
  status: string | null;
  entitlements: Map<string, { enabled: boolean; limit: number | null }>;
}

/** Resolves the organization's effective plan: live subscription, else the organization's default plan. */
export async function loadPlanState(trx: Trx, orgId: string): Promise<PlanState> {
  const sub = await trx('subscriptions').where({ organization_id: orgId }).whereIn('status', ['trialing', 'active', 'past_due']).first();
  let planKey: string | null;
  if (sub) planKey = sub.plan_key;
  else planKey = (await trx('organizations').where({ id: orgId }).first('plan_key'))?.plan_key ?? null;
  if (!planKey) return { planKey: 'unmetered', restricted: false, metered: false, status: null, entitlements: new Map() };
  const rows = await trx('plan_entitlements').where({ plan_key: planKey });
  return {
    planKey, restricted: !!sub?.restricted, metered: true, status: sub?.status ?? null,
    entitlements: new Map(rows.map((r) => [r.feature_key as string, { enabled: !!r.enabled, limit: r.limit_value === null ? null : Number(r.limit_value) }])),
  };
}

/**
 * Enforced only when the billing module is on for the organization (module flag), so MVP deployments are unaffected.
 * Returns 402 PLAN_LIMIT_EXCEEDED for missing features, exhausted limits and restricted (dunning) accounts.
 */
export async function assertPlanAllows(
  trx: Trx, orgId: string, opts: { method: string; module: string; entitlement?: EntitlementSpec },
): Promise<void> {
  if (!(await isFlagEnabled(trx, 'module.billing', { organizationId: orgId }))) return;
  const plan = await loadPlanState(trx, orgId);
  if (!plan.metered) return;
  if (plan.restricted && opts.method !== 'GET' && opts.module !== 'billing') {
    throw new AppError('PLAN_LIMIT_EXCEEDED', 'The account is restricted (read-only) due to an unpaid subscription', [{ issue: 'subscription_restricted' }]);
  }
  const spec = opts.entitlement;
  if (!spec) return;
  const ent = plan.entitlements.get(spec.key);
  if (!ent || !ent.enabled) {
    throw new AppError('PLAN_LIMIT_EXCEEDED', 'This feature is not included in your plan', [{ field: spec.key, issue: 'not_in_plan' }]);
  }
  if (ent.limit !== null && spec.count) {
    const used = await spec.count({ trx, orgId });
    if (used >= ent.limit) {
      throw new AppError('PLAN_LIMIT_EXCEEDED', `Your plan allows at most ${ent.limit}`, [{ field: spec.key, issue: `limit_reached:${ent.limit}` }]);
    }
  }
}
