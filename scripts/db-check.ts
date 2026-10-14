/** latest -> rollback all -> latest: proves every migration has a working `down` and runs on a clean schema. */
import 'dotenv/config';
import knexLib from 'knex';

const url = process.env.MIGRATOR_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error('MIGRATOR_DATABASE_URL or DATABASE_URL is required');
  process.exit(2);
}
const db = knexLib({ client: 'pg', connection: url });
const cfg = { directory: './migrations', loadExtensions: ['.ts'] };
try {
  const [, up1] = await db.migrate.latest(cfg);
  console.log(`up:   ${up1.length} migration(s) applied`);
  const [, down] = await db.migrate.rollback(cfg, true);
  console.log(`down: ${down.length} migration(s) rolled back`);
  const [, up2] = await db.migrate.latest(cfg);
  console.log(`up:   ${up2.length} migration(s) re-applied`);
  if (up2.length === 0) throw new Error('re-apply produced no migrations');
  console.log('db:check passed');
} catch (e) {
  console.error('db:check FAILED:', (e as Error).message);
  process.exitCode = 1;
} finally {
  await db.destroy();
}
