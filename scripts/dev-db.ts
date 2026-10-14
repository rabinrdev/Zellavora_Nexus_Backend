// Starts a local embedded PostgreSQL (used when Docker is unavailable) and prints its URL.
import EmbeddedPostgres from 'embedded-postgres';
import { existsSync } from 'node:fs';

const dataDir = process.env.PGDATA_DIR ?? '.pgdata';
const port = Number(process.env.PGPORT ?? 54329);
const pg = new EmbeddedPostgres({ databaseDir: dataDir, user: 'postgres', password: 'postgres', port, persistent: true });
if (!existsSync(`${dataDir}/PG_VERSION`)) await pg.initialise();
await pg.start();
try { await pg.createDatabase('nexus'); } catch { /* already exists */ }
console.log(`postgres://postgres:postgres@localhost:${port}/nexus`);
process.on('SIGINT', async () => { await pg.stop(); process.exit(0); });
setInterval(() => {}, 1 << 30);
