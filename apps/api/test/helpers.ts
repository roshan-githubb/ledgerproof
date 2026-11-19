import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { expect, inject } from 'vitest';
import { createTenantWithKey } from '../src/admin.js';
import { buildApp } from '../src/app.js';
import { createPool } from '../src/db/pool.js';
import type { Account } from '../src/ledger/accounts.js';

export interface TestEnv {
  app: FastifyInstance;
  /** Same role and privileges as the production API. */
  appPool: pg.Pool;
  /** Owner: bypasses row-level security. For setup and for checking results. */
  adminPool: pg.Pool;
  close: () => Promise<void>;
}

const APP_POOL_SIZE = 15;

export async function startTestEnv(): Promise<TestEnv> {
  const appPool = createPool(inject('appUrl'), { max: APP_POOL_SIZE, idleTimeoutMillis: 0 });
  const adminPool = createPool(inject('adminUrl'), { max: 3 });
  // Open every connection up front. A cold pool opens connections one at a time as work
  // arrives, which staggers "concurrent" transactions so they never overlap and races stay
  // hidden. Found by `pnpm mutation-check`; see docs/ai-workflow-log.md.
  const clients = await Promise.all(Array.from({ length: APP_POOL_SIZE }, () => appPool.connect()));
  for (const client of clients) client.release();
  const app = buildApp({ pool: appPool });
  await app.ready();
  return {
    app,
    appPool,
    adminPool,
    close: async () => {
      await app.close();
      await appPool.end();
      await adminPool.end();
    },
  };
}

export interface TransferBody {
  from_account_id: string;
  to_account_id: string;
  amount: string;
  currency: string;
  description?: string | null;
  metadata?: Record<string, string>;
}

/** A thin HTTP client for one tenant, going through the full Fastify stack. */
export function apiFor(app: FastifyInstance, apiKey: string) {
  const authorization = `Bearer ${apiKey}`;
  return {
    createAccount: (body: object) =>
      app.inject({ method: 'POST', url: '/v1/accounts', headers: { authorization }, payload: body }),
    transfer: (body: TransferBody, idempotencyKey: string = randomUUID()) =>
      app.inject({
        method: 'POST',
        url: '/v1/transfers',
        headers: { authorization, 'idempotency-key': idempotencyKey },
        payload: body,
      }),
    get: (url: string) => app.inject({ method: 'GET', url, headers: { authorization } }),
  };
}

export type Api = ReturnType<typeof apiFor>;

export async function newTenant(env: TestEnv, name = 'tenant') {
  const created = await createTenantWithKey(env.adminPool, `${name}-${randomUUID()}`);
  return { ...created, api: apiFor(env.app, created.apiKey) };
}

export async function createAccount(
  api: Api,
  reference: string,
  opts: { currency?: string; allowNegative?: boolean } = {},
): Promise<Account> {
  const res = await api.createAccount({
    reference,
    currency: opts.currency ?? 'USD',
    allow_negative: opts.allowNegative ?? false,
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

export async function fund(api: Api, fromId: string, toId: string, amount: string, currency = 'USD') {
  const res = await api.transfer({ from_account_id: fromId, to_account_id: toId, amount, currency });
  expect(res.statusCode, res.body).toBe(201);
}

export async function balanceOf(api: Api, accountId: string): Promise<string> {
  const res = await api.get(`/v1/accounts/${accountId}`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json().balance;
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Fault-injection hook for createTransfer: pauses between the balance check and the write.
 * With correct locking this only slows the test down. With a missing lock it guarantees that
 * concurrent transfers act on stale reads, so the test fails every time instead of by luck.
 * (Without it, the race showed up in tests only occasionally: docs/ai-workflow-log.md.)
 */
export const widenRaceWindow = { afterInsert: () => sleep(20) };

/** 'created' / 'replayed' for a successful transfer, otherwise the error code. */
export async function outcome(transfer: Promise<{ replayed: boolean }>): Promise<string> {
  try {
    return (await transfer).replayed ? 'replayed' : 'created';
  } catch (err) {
    // LedgerError code, or the Postgres SQLSTATE for unexpected database errors.
    return (err as { code?: string }).code ?? String(err);
  }
}

export function countBy<T extends string | number>(values: T[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const v of values) counts[String(v)] = (counts[String(v)] ?? 0) + 1;
  return counts;
}

/** Runs queries as the app role inside a transaction that is always rolled back. */
export async function asAppRole<T>(
  appPool: pg.Pool,
  tenantId: string | null,
  fn: (db: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await appPool.connect();
  try {
    await client.query('BEGIN');
    if (tenantId) await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    return await fn(client);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}
