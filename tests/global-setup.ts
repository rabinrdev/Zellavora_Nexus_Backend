import knexLib from 'knex';

export default async function setup() {
  const url = process.env.MIGRATOR_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:54329/nexus';
  const db = knexLib({ client: 'pg', connection: url });
  await db.migrate.latest({ directory: './migrations', loadExtensions: ['.ts'] });
  await db.destroy();
}
