import type { Knex } from 'knex';
import { newId } from '../src/platform/crypto.js';
import { hashPassword } from '../src/platform/auth/password.js';

/**
 * Development seed. Safe, obviously fake data (@example.test); refuses to run in production.
 * Login: owner@acme.example.test / Dev-Passw0rd-Change-Me  (org code: acme-demo)
 */
export async function seed(knex: Knex): Promise<void> {
  if (process.env.NODE_ENV === 'production') throw new Error('Refusing to seed a production database');
  const exists = await knex('organizations').where({ code: 'acme-demo' }).first();
  if (exists) return;
  const password = await hashPassword('Dev-Passw0rd-Change-Me');
  const ownerId = newId();
  await knex('users').insert({
    id: ownerId, email: 'owner@acme.example.test', name: 'Demo Owner', password_hash: password, password_changed_at: new Date(), email_verified_at: new Date(),
  });
  const orgId = newId();
  await knex.transaction(async (trx) => {
    await trx.raw(`SELECT set_config('app.platform', 'on', true)`);
    await trx('organizations').insert({ id: orgId, name: 'Acme Demo', code: 'acme-demo', slug: 'acme-demo', type: 'business', owner_user_id: ownerId });
    const membershipId = newId();
    await trx('organization_memberships').insert({ id: membershipId, organization_id: orgId, user_id: ownerId, status: 'active', joined_at: new Date() });
    await trx('user_role_assignments').insert({
      id: newId(), organization_id: orgId, membership_id: membershipId, role_id: '00000000-0000-7000-8000-000000000001', scope_type: 'organization',
    });
    await trx('storage_usage').insert({ organization_id: orgId, bytes_used: 0 });
    await trx('departments').insert([
      { id: newId(), organization_id: orgId, name: 'Engineering', created_by: ownerId },
      { id: newId(), organization_id: orgId, name: 'Operations', created_by: ownerId },
    ]);
  });
}
