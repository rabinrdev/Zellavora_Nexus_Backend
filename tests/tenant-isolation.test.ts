import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import knexLib from 'knex';
import { randomUUID } from 'node:crypto';
import { withTenant } from '../src/db/knex.js';

const ADMIN = process.env.MIGRATOR_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:54329/nexus';
const APP = process.env.DATABASE_URL ?? 'postgres://nexus_app:nexus_app_dev_pw@localhost:54329/nexus';
const admin = knexLib({ client: 'pg', connection: ADMIN });
const app = knexLib({ client: 'pg', connection: APP });
const orgA = randomUUID();
const orgB = randomUUID();
const user = randomUUID();

beforeAll(async () => {
  await admin.migrate.latest({ directory: './migrations', loadExtensions: ['.ts'] });
  await admin('users').insert({ id: user, email: `u-${user}@example.test`, name: 'Test User' });
  for (const [id, code] of [[orgA, 'a'], [orgB, 'b']] as const)
    await admin('organizations').insert({ id, name: code, code: `${code}-${id}`, slug: `${code}-${id}` });
  for (const id of [orgA, orgB])
    await admin('audit_events').insert({ id: randomUUID(), organization_id: id, action: 'x', outcome: 'success' });
});

afterAll(async () => {
  await admin.destroy();
  await app.destroy();
});

describe('RLS tenant isolation', () => {
  it('only returns rows of the active organization', async () => {
    const rows = await withTenant(app, { organizationId: orgA, userId: user }, (t) =>
      t('audit_events').select('organization_id'),
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.organization_id === orgA)).toBe(true);
  });

  it('returns nothing when no tenant context is set (fail closed)', async () => {
    expect(await app('audit_events').select('id')).toHaveLength(0);
  });

  it('rejects cross-tenant writes', async () => {
    await expect(
      withTenant(app, { organizationId: orgA, userId: user }, (t) =>
        t('audit_events').insert({ id: randomUUID(), organization_id: orgB, action: 'x', outcome: 'success' }),
      ),
    ).rejects.toThrow();
  });

  it('audit_events is append-only', async () => {
    await expect(admin('audit_events').where({ organization_id: orgA }).update({ action: 'tampered' })).rejects.toThrow(
      /append-only/,
    );
  });
});
