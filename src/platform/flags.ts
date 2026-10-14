import type { Knex } from 'knex';

export const MODULE_FLAGS = [
  'module.teams', 'module.projects', 'module.timesheets', 'module.approvals', 'module.invoices',
  'module.notifications', 'module.crm', 'module.documents', 'module.cms', 'module.pagebuilder', 'module.themes',
  'module.billing', 'module.integrations', 'module.reports', 'module.platform_ops', 'module.workflow',
  'module.support',
] as const;

/** Resolution order: user override > organization override > global default. */
export async function isFlagEnabled(
  db: Knex | Knex.Transaction,
  key: string,
  ctx: { organizationId?: string | null; userId?: string | null } = {},
): Promise<boolean> {
  const rows = await db('feature_flags as f')
    .leftJoin('feature_flag_overrides as o', function () {
      this.on('o.flag_key', 'f.key');
    })
    .where('f.key', key)
    .select('f.default_enabled', 'o.target_org_id', 'o.user_id', 'o.enabled');
  if (rows.length === 0) return false;
  const user = rows.find((r) => r.user_id && r.user_id === ctx.userId);
  if (user) return !!user.enabled;
  const org = rows.find((r) => !r.user_id && r.target_org_id && r.target_org_id === ctx.organizationId);
  if (org) return !!org.enabled;
  return !!rows[0].default_enabled;
}

export async function evaluateAll(
  db: Knex | Knex.Transaction,
  ctx: { organizationId?: string | null; userId?: string | null },
): Promise<Record<string, boolean>> {
  const flags = await db('feature_flags').select('key');
  const out: Record<string, boolean> = {};
  for (const f of flags) out[f.key as string] = await isFlagEnabled(db, f.key as string, ctx);
  return out;
}

export async function seedFlags(db: Knex, enabledByDefault: boolean): Promise<void> {
  for (const key of MODULE_FLAGS) {
    await db('feature_flags')
      .insert({ key, description: `Enables ${key}`, default_enabled: enabledByDefault })
      .onConflict('key')
      .ignore();
  }
}
