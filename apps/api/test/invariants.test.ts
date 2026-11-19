import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Account } from '../src/ledger/accounts.js';
import { findViolations } from '../src/ledger/reconcile.js';
import { createAccount, fund, newTenant, startTestEnv, type TestEnv } from './helpers.js';

/** Small seeded PRNG so a failing run can be reproduced with SEED=<n>. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('ledger invariants', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await startTestEnv();
  });
  afterAll(async () => {
    await env.close();
  });

  it('hold after 200 random concurrent transfers: balances match history, tenant nets to zero', async () => {
    const seed = Number(process.env.SEED ?? 20261119);
    const random = mulberry32(seed);
    const { tenantId, api } = await newTenant(env);
    const world = await createAccount(api, 'world', { allowNegative: true });
    const payouts = await createAccount(api, 'payouts');
    const wallets: Account[] = [];
    for (let i = 0; i < 6; i++) {
      const wallet = await createAccount(api, `wallet:${i}`);
      await fund(api, world.id, wallet.id, '500');
      wallets.push(wallet);
    }
    const destinations = [...wallets, payouts];

    const results = await Promise.all(
      Array.from({ length: 200 }, () => {
        const from = wallets[Math.floor(random() * wallets.length)]!;
        let to = destinations[Math.floor(random() * destinations.length)]!;
        if (to.id === from.id) to = payouts;
        const amount = String(1 + Math.floor(random() * 200));
        return api.transfer({ from_account_id: from.id, to_account_id: to.id, amount, currency: 'USD' });
      }),
    );

    const statuses = new Set(results.map((r) => r.statusCode));
    expect([...statuses].every((s) => s === 201 || s === 422), `seed ${seed}: ${[...statuses]}`).toBe(true);
    expect(await findViolations(env.adminPool, tenantId), `seed ${seed}`).toEqual([]);
  });

  // The invariant test above is only meaningful if the checker can actually find a problem.
  it('the checker reports drift when a balance is corrupted behind the ledger’s back', async () => {
    const { tenantId, api } = await newTenant(env);
    const world = await createAccount(api, 'world', { allowNegative: true });
    const wallet = await createAccount(api, 'wallet');
    await fund(api, world.id, wallet.id, '100');
    expect(await findViolations(env.adminPool, tenantId)).toEqual([]);

    await env.adminPool.query('UPDATE accounts SET balance = balance + 1 WHERE id = $1', [wallet.id]);

    const kinds = (await findViolations(env.adminPool, tenantId)).map((v) => v.kind).sort();
    expect(kinds).toEqual(['balance_drift', 'tenant_not_zero']);
  });
});
