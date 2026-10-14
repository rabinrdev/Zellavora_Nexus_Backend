/**
 * Creates (or promotes) a platform super admin from the command line. The password is read from
 * SUPER_ADMIN_PASSWORD so it never appears in shell history or process lists.
 *   SUPER_ADMIN_EMAIL=ops@example.com SUPER_ADMIN_PASSWORD=... npm run admin:create
 */
import 'dotenv/config';
import knexLib from 'knex';
import { newId } from '../src/platform/crypto.js';
import { hashPassword, passwordProblems, DEFAULT_PASSWORD_POLICY } from '../src/platform/auth/password.js';

const url = process.env.MIGRATOR_DATABASE_URL ?? process.env.DATABASE_URL;
const email = process.env.SUPER_ADMIN_EMAIL?.toLowerCase();
const password = process.env.SUPER_ADMIN_PASSWORD;
const name = process.env.SUPER_ADMIN_NAME ?? 'Platform Admin';
if (!url || !email || !password) {
  console.error('DATABASE_URL (or MIGRATOR_DATABASE_URL), SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD are required');
  process.exit(2);
}
const problems = passwordProblems(password, { ...DEFAULT_PASSWORD_POLICY, minLength: 14 }, { email });
if (problems.length) {
  console.error(`Password rejected: ${problems.join('; ')}`);
  process.exit(2);
}
const db = knexLib({ client: 'pg', connection: url });
const hash = await hashPassword(password);
const existing = await db('users').where({ email }).first();
if (existing) {
  await db('users').where({ id: existing.id }).update({
    is_platform_admin: true, password_hash: hash, password_changed_at: new Date(), email_verified_at: existing.email_verified_at ?? new Date(),
    permission_version: db.raw('permission_version + 1'),
  });
  console.log(`Promoted existing user ${email} to platform admin`);
} else {
  await db('users').insert({
    id: newId(), email, name, password_hash: hash, password_changed_at: new Date(), email_verified_at: new Date(), is_platform_admin: true,
  });
  console.log(`Created platform admin ${email}`);
}
await db.destroy();
