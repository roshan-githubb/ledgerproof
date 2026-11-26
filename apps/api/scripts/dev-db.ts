// Local Postgres without Docker: real PostgreSQL binaries via embedded-postgres.
// Usage: pnpm --filter @ledgerproof/api dev-db   (keeps running; Ctrl+C to stop)
import EmbeddedPostgres from 'embedded-postgres';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { migrate } from '../src/db/migrate.js';
import { stopEmbeddedPostgres } from './lib/embedded-postgres.js';

const port = Number(process.env.DEV_DB_PORT ?? 5432);
const dataDir = fileURLToPath(new URL('../../../.tmp/pgdata', import.meta.url));
const ep = new EmbeddedPostgres({
  databaseDir: path.normalize(dataDir),
  user: 'postgres',
  password: 'postgres',
  port,
  persistent: true,
  onLog: () => {},
});

const fresh = !(await import('node:fs')).existsSync(path.join(dataDir, 'PG_VERSION'));
if (fresh) await ep.initialise();
await ep.start();
const adminUrl = `postgres://postgres:postgres@localhost:${port}/ledgerproof`;
if (fresh) await ep.createDatabase('ledgerproof');
await migrate(adminUrl);

const admin = new pg.Client({ connectionString: adminUrl });
await admin.connect();
await admin.query(`
  DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ledger_api') THEN
      CREATE ROLE ledger_api LOGIN PASSWORD 'ledger_api' IN ROLE ledger_app;
    END IF;
  END $$;`);
await admin.end();

console.log(`ADMIN_DATABASE_URL=${adminUrl}`);
console.log(`DATABASE_URL=postgres://ledger_api:ledger_api@localhost:${port}/ledgerproof`);
console.log('Postgres is running. Ctrl+C to stop.');

const stop = async () => {
  await stopEmbeddedPostgres(ep, { databaseDir: path.normalize(dataDir), persistent: true });
  process.exit(0);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
