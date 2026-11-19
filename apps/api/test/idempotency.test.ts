import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTransfer } from '../src/ledger/transfers.js';
import {
  balanceOf,
  countBy,
  createAccount,
  fund,
  newTenant,
  outcome,
  startTestEnv,
  widenRaceWindow,
  type TestEnv,
} from './helpers.js';

describe('idempotency', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await startTestEnv();
  });
  afterAll(async () => {
    await env.close();
  });

  async function walletWith(balance: string) {
    const tenant = await newTenant(env);
    const world = await createAccount(tenant.api, 'world', { allowNegative: true });
    const wallet = await createAccount(tenant.api, 'wallet:alice');
    const sink = await createAccount(tenant.api, 'payouts');
    if (balance !== '0') await fund(tenant.api, world.id, wallet.id, balance);
    return { ...tenant, world, wallet, sink };
  }

  async function transferCount(tenantId: string, key: string): Promise<number> {
    const { rows } = await env.adminPool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM transfers WHERE tenant_id = $1 AND idempotency_key = $2',
      [tenantId, key],
    );
    return rows[0]!.n;
  }

  it('replays a retried request: same key and body return the same transfer, money moves once', async () => {
    const { api, wallet, sink } = await walletWith('100');
    const key = randomUUID();
    const body = { from_account_id: wallet.id, to_account_id: sink.id, amount: '30', currency: 'USD' };

    const first = await api.transfer(body, key);
    const retry = await api.transfer(body, key);

    expect(first.statusCode).toBe(201);
    expect(retry.statusCode).toBe(200);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.json().id).toBe(first.json().id);
    expect(await balanceOf(api, wallet.id)).toBe('70');
  });

  // Without the advisory lock, the duplicates all pass the "seen this key?" check while the
  // first is still in flight, wait for its row locks, then find the balance spent and return
  // insufficient_funds instead of the original result. Called directly with a widened race
  // window so that happens every time (see test/concurrency.test.ts for why not via HTTP).
  it('concurrent duplicates: 20 identical requests at once create exactly one transfer', async () => {
    const { tenantId, api, wallet, sink } = await walletWith('100');
    const key = randomUUID();
    const input = { fromAccountId: wallet.id, toAccountId: sink.id, amount: '100', currency: 'USD' };

    const outcomes = await Promise.all(
      Array.from({ length: 20 }, () =>
        outcome(createTransfer(env.appPool, tenantId, key, input, widenRaceWindow)),
      ),
    );

    expect(countBy(outcomes)).toEqual({ created: 1, replayed: 19 });
    expect(await transferCount(tenantId, key)).toBe(1);
    expect(await balanceOf(api, wallet.id)).toBe('0');
    expect(await balanceOf(api, sink.id)).toBe('100');
  });

  it('rejects a reused key with a different body (409) and does not move money again', async () => {
    const { tenantId, api, wallet, sink } = await walletWith('100');
    const key = randomUUID();
    const body = { from_account_id: wallet.id, to_account_id: sink.id, amount: '30', currency: 'USD' };

    expect((await api.transfer(body, key)).statusCode).toBe(201);
    const reused = await api.transfer({ ...body, amount: '31' }, key);

    expect(reused.statusCode).toBe(409);
    expect(reused.json().error.code).toBe('idempotency_key_reused');
    expect(await transferCount(tenantId, key)).toBe(1);
    expect(await balanceOf(api, wallet.id)).toBe('70');
  });

  it('treats differently-cased account ids as the same request (replay, not 409)', async () => {
    const { api, wallet, sink } = await walletWith('100');
    const key = randomUUID();
    const body = { from_account_id: wallet.id, to_account_id: sink.id, amount: '5', currency: 'USD' };

    const first = await api.transfer(body, key);
    const retry = await api.transfer(
      { ...body, from_account_id: wallet.id.toUpperCase(), to_account_id: sink.id.toUpperCase() },
      key,
    );

    expect(first.statusCode).toBe(201);
    expect(retry.statusCode).toBe(200);
    expect(retry.json().id).toBe(first.json().id);
  });

  // Design decision (ADR 0003): only successful transfers are recorded against a key, so a
  // rejected request can be retried once the reason is fixed. It still can never move money twice.
  it('a rejected request does not use up its key: the retry succeeds after funding', async () => {
    const { tenantId, api, world, wallet, sink } = await walletWith('0');
    const key = randomUUID();
    const body = { from_account_id: wallet.id, to_account_id: sink.id, amount: '50', currency: 'USD' };

    const rejected = await api.transfer(body, key);
    expect(rejected.statusCode).toBe(422);
    await fund(api, world.id, wallet.id, '50');
    const retry = await api.transfer(body, key);

    expect(retry.statusCode).toBe(201);
    expect(await transferCount(tenantId, key)).toBe(1);
  });

  it('scopes keys per tenant: two tenants can use the same key independently', async () => {
    const t1 = await walletWith('100');
    const t2 = await walletWith('100');
    const key = 'order-1001';

    const r1 = await t1.api.transfer(
      { from_account_id: t1.wallet.id, to_account_id: t1.sink.id, amount: '10', currency: 'USD' },
      key,
    );
    const r2 = await t2.api.transfer(
      { from_account_id: t2.wallet.id, to_account_id: t2.sink.id, amount: '20', currency: 'USD' },
      key,
    );

    expect(r1.statusCode).toBe(201);
    expect(r2.statusCode).toBe(201);
  });

  // "What if the process crashes halfway?" The database connection is killed after the
  // transfer row is inserted but before either balance is updated. Nothing may survive, and
  // the client's retry with the same key must then succeed exactly once.
  it('crash halfway: killing the connection between insert and balance update leaves nothing behind', async () => {
    const { tenantId, api, wallet, sink } = await walletWith('100');
    const key = randomUUID();
    const input = { fromAccountId: wallet.id, toAccountId: sink.id, amount: '30', currency: 'USD' };

    await expect(
      createTransfer(env.appPool, tenantId, key, input, {
        afterInsert: async (db) => {
          const { rows } = await db.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
          // Waits (up to 5s) until the backend is really gone.
          const killed = await env.adminPool.query<{ ok: boolean }>(
            'SELECT pg_terminate_backend($1, 5000) AS ok',
            [rows[0]!.pid],
          );
          expect(killed.rows[0]!.ok).toBe(true);
        },
      }),
    ).rejects.toThrow();

    expect(await transferCount(tenantId, key)).toBe(0);
    expect(await balanceOf(api, wallet.id)).toBe('100');
    expect(await balanceOf(api, sink.id)).toBe('0');

    const retry = await createTransfer(env.appPool, tenantId, key, input);
    expect(retry.replayed).toBe(false);
    expect(await transferCount(tenantId, key)).toBe(1);
    expect(await balanceOf(api, wallet.id)).toBe('70');
    expect(await balanceOf(api, sink.id)).toBe('30');
  });
});
