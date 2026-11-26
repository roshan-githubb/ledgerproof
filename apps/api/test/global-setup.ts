import { mkdtemp } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { stopEmbeddedPostgres } from '../scripts/lib/embedded-postgres.js';
import { migrate } from '../src/db/migrate.js';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Owner connection: bypasses row-level security. Setup and verification only. */
    adminUrl: string;
    /** Connection as a ledger_app member, exactly like the API in production. */
    appUrl: string;
  }
}

interface RunningPostgres {
  url: string;
  kind: string;
  stop: () => Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

/**
 * Real Postgres for every test run, in order of preference:
 * 1. TEST_DATABASE_URL, if set (an owner connection to a throwaway database)
 * 2. Testcontainers, when a Docker runtime is available (CI)
 * 3. embedded-postgres: the official PostgreSQL binaries run as a local process (no Docker)
 */
async function startPostgres(): Promise<RunningPostgres> {
  const fromEnv = process.env.TEST_DATABASE_URL;
  if (fromEnv) return { url: fromEnv, kind: 'TEST_DATABASE_URL', stop: async () => {} };

  try {
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
    const container = await new PostgreSqlContainer('postgres:18-alpine').start();
    return {
      url: container.getConnectionUri(),
      kind: 'Testcontainers (postgres:18-alpine)',
      stop: async () => {
        await container.stop();
      },
    };
  } catch (err) {
    if (!/container runtime/i.test((err as Error).message ?? '')) throw err;
  }

  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const databaseDir = await mkdtemp(path.join(tmpdir(), 'ledgerproof-test-'));
  const port = await freePort();
  const ep = new EmbeddedPostgres({
    databaseDir,
    port,
    user: 'postgres',
    password: 'postgres',
    persistent: false,
    postgresFlags: ['-c', 'max_connections=300'],
    onLog: () => {},
  });
  await ep.initialise();
  await ep.start();
  await ep.createDatabase('ledgerproof_test');
  return {
    url: `postgres://postgres:postgres@localhost:${port}/ledgerproof_test`,
    kind: 'embedded-postgres (no Docker runtime found)',
    stop: () => stopEmbeddedPostgres(ep, { databaseDir, persistent: false }),
  };
}

export default async function setup(project: TestProject) {
  const db = await startPostgres();
  console.log(`[test db] ${db.kind}`);
  await migrate(db.url, () => {});

  const admin = new pg.Client({ connectionString: db.url });
  await admin.connect();
  await admin.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ledger_api_test') THEN
        CREATE ROLE ledger_api_test LOGIN PASSWORD 'test' IN ROLE ledger_app;
      END IF;
    END $$;`);
  await admin.end();

  const appUrl = new URL(db.url);
  appUrl.username = 'ledger_api_test';
  appUrl.password = 'test';

  project.provide('adminUrl', db.url);
  project.provide('appUrl', appUrl.toString());

  return async () => {
    const started = Date.now();
    await db.stop();
    console.log(`[test db] stopped in ${Date.now() - started} ms`);
  };
}
