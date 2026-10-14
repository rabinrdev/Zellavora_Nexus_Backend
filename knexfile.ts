import 'dotenv/config';
import type { Knex } from 'knex';

// Works from source (tsx) and from the compiled `dist/` output (node).
const ext = import.meta.url.endsWith('.ts') ? 'ts' : 'js';

const config: Knex.Config = {
  client: 'pg',
  connection: process.env.MIGRATOR_DATABASE_URL ?? process.env.DATABASE_URL,
  migrations: { directory: './migrations', extension: ext, loadExtensions: [`.${ext}`] },
  seeds: { directory: './seeds', loadExtensions: [`.${ext}`] },
};
export default config;
