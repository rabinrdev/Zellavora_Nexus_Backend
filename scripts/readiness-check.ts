/**
 * Pre-release readiness gate for staging/production (F-178). Exits non-zero on any blocking finding.
 *   NODE_ENV=production npm run readiness
 */
import 'dotenv/config';
import knexLib from 'knex';
import { loadEnv } from '../src/config/env.js';

const findings: { level: 'FAIL' | 'WARN' | 'OK'; msg: string }[] = [];
const add = (level: 'FAIL' | 'WARN' | 'OK', msg: string) => findings.push({ level, msg });

let env: ReturnType<typeof loadEnv> | null = null;
try {
  env = loadEnv();
  add('OK', 'environment validates');
} catch (e) {
  add('FAIL', (e as Error).message);
}

if (env) {
  const prod = env.NODE_ENV === 'production';
  if (env.JWT_SECRET.length < 48) add(prod ? 'FAIL' : 'WARN', 'JWT_SECRET should be at least 48 characters of random data');
  if (/^(0f)+$|^(00)+$/.test(env.DATA_ENCRYPTION_KEY.slice(0, 64))) add(prod ? 'FAIL' : 'WARN', 'DATA_ENCRYPTION_KEY looks like a placeholder');
  if (prod && env.DATABASE_URL.includes('postgres:postgres@')) add('FAIL', 'DATABASE_URL uses the default superuser credentials');
  if (prod && /postgres:\/\/postgres[:@]/.test(env.DATABASE_URL)) add('FAIL', 'runtime must connect as nexus_app, not a superuser');
  if (prod && !env.METRICS_TOKEN) add('WARN', 'METRICS_TOKEN is not set: /metrics is hidden in production without it');
  if (prod && env.CORS_ORIGINS.length === 0) add('FAIL', 'CORS_ORIGINS is empty');
  if (prod && env.MAIL_DRIVER === 'console') add('FAIL', 'MAIL_DRIVER=console in production');
  if (prod && env.SWAGGER) add('WARN', 'Swagger UI is enabled in production');
  if (prod && env.SCAN_DRIVER !== 'clamd') add('FAIL', 'malware scanning must use clamd in production');
  if (prod && !env.ERROR_TRACKING_DSN) add('WARN', 'ERROR_TRACKING_DSN is not set: unexpected errors are only logged');

  const db = knexLib({ client: 'pg', connection: env.MIGRATOR_DATABASE_URL ?? env.DATABASE_URL });
  try {
    await db.raw('select 1');
    add('OK', 'database reachable');
    const [, pending] = await db.migrate.list({ directory: './migrations', loadExtensions: ['.ts', '.js'] });
    add(pending.length === 0 ? 'OK' : 'FAIL', pending.length === 0 ? 'all migrations applied' : `${pending.length} pending migration(s)`);
    const role = (await db.raw(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'nexus_app'`)).rows[0];
    add(role && !role.rolsuper && !role.rolbypassrls ? 'OK' : 'FAIL', 'nexus_app is a non-superuser without BYPASSRLS');
    const noRls = (await db.raw(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
        WHERE c.relkind = 'r' AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity)
          AND EXISTS (SELECT 1 FROM information_schema.columns k WHERE k.table_schema='public' AND k.table_name=c.relname AND k.column_name='organization_id')`,
    )).rows;
    add(noRls.length === 0 ? 'OK' : 'FAIL', noRls.length === 0 ? 'RLS enforced on every tenant table' : `RLS missing: ${noRls.map((r: { relname: string }) => r.relname).join(', ')}`);
    const flags = (await db('feature_flags').select('key', 'default_enabled')) as { key: string; default_enabled: boolean }[];
    const on = flags.filter((f) => f.default_enabled).map((f) => f.key);
    if (prod && on.length) add('WARN', `module flags ON by default in production: ${on.join(', ')}`);
    const lastBackup = await db('backup_runs').where({ status: 'completed' }).max({ at: 'finished_at' }).first();
    const at = (lastBackup as { at: Date | null } | undefined)?.at;
    add(at && Date.now() - new Date(at).getTime() < 36 * 3600_000 ? 'OK' : prod ? 'FAIL' : 'WARN', at ? `last backup ${new Date(at).toISOString()}` : 'no recorded backup');
  } catch (e) {
    add('FAIL', `database checks failed: ${(e as Error).message}`);
  } finally {
    await db.destroy();
  }
}

for (const f of findings) console.log(`${f.level.padEnd(4)}  ${f.msg}`);
const fails = findings.filter((f) => f.level === 'FAIL').length;
console.log(`\n${fails === 0 ? 'READY' : 'NOT READY'}: ${fails} blocking finding(s), ${findings.filter((f) => f.level === 'WARN').length} warning(s)`);
process.exit(fails === 0 ? 0 : 1);
