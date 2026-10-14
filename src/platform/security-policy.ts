import type { Knex } from 'knex';
import { withPlatformScope } from './scope.js';
import { DEFAULT_PASSWORD_POLICY, type PasswordPolicy } from './auth/password.js';

export interface SecurityPolicy {
  password: PasswordPolicy;
  session: { idleMinutes: number; absoluteMinutes: number };
  lockout: { threshold: number; baseMinutes: number; maxMinutes: number };
  mfa: { requiredForRoles: string[]; requiredForAll: boolean };
  allowedIpRanges: string[];
}

export const DEFAULT_SECURITY_POLICY: SecurityPolicy = {
  password: DEFAULT_PASSWORD_POLICY,
  session: { idleMinutes: 8 * 60, absoluteMinutes: 30 * 24 * 60 },
  lockout: { threshold: 5, baseMinutes: 1, maxMinutes: 60 },
  mfa: { requiredForRoles: [], requiredForAll: false },
  allowedIpRanges: [],
};

function merge<T extends object>(base: T, over: object | undefined): T {
  if (!over) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over)) {
    const b = out[k];
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && b && typeof b === 'object' && !Array.isArray(b)
      ? merge(b as object, v as object)
      : v;
  }
  return out as T;
}

/** defaults < global policy row < organization policy row. Applied dynamically by auth (F-152). */
export async function loadSecurityPolicy(db: Knex, organizationId: string | null): Promise<SecurityPolicy> {
  return withPlatformScope(db, 'security-policy-read', async (t) => {
    let p = DEFAULT_SECURITY_POLICY;
    const global = await t('security_policies').whereNull('organization_id').first();
    if (global) p = merge(p, global.policy as Partial<SecurityPolicy>);
    if (organizationId) {
      const org = await t('security_policies').where({ organization_id: organizationId }).first();
      if (org) p = merge(p, org.policy as Partial<SecurityPolicy>);
    }
    return p;
  });
}
