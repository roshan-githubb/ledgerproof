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

// These call the ledger directly rather than through HTTP. Through HTTP, the per-request API
// key lookup staggers requests enough that the races below appear only occasionally, so a
// broken lock could still pass. The HTTP path is covered by the 200-request invariants test.
describe('concurrent transfers', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await startTestEnv();
  });
  afterAll(async () => {
    await env.close();
  });

  // Claim: no overdraft under concurrency. Without FOR UPDATE, transfers check a stale
  // balance; the CHECK constraint then rejects the overdraft with 23514 where a clean
  // insufficient_funds is expected, and this test fails (proven by `pnpm mutation-check`).
  it('never overdraws: 50 concurrent 10-unit spends from a balance of 100, exactly 10 succeed', async () => {
    const { tenantId, api } = await newTenant(env);
    const world = await createAccount(api, 'world', { allowNegative: true });
    const wallet = await createAccount(api, 'wallet:alice');
    const sink = await createAccount(api, 'payouts');
    await fund(api, world.id, wallet.id, '100');
    const input = { fromAccountId: wallet.id, toAccountId: sink.id, amount: '10', currency: 'USD' };

    const outcomes = await Promise.all(
      Array.from({ length: 50 }, () =>
        outcome(createTransfer(env.appPool, tenantId, randomUUID(), input, widenRaceWindow)),
      ),
    );

    expect(countBy(outcomes)).toEqual({ created: 10, insufficient_funds: 40 });
    expect(await balanceOf(api, wallet.id)).toBe('0');
    expect(await balanceOf(api, sink.id)).toBe('100');
  });

  // Claim: no deadlocks. If accounts were locked in request order (from, then to), A->B and
  // B->A would each hold one lock and wait for the other, and Postgres would abort one with
  // 40P01 (deadlock_detected).
  it('does not deadlock: 100 concurrent transfers in both directions all succeed', async () => {
    const { tenantId, api } = await newTenant(env);
    const world = await createAccount(api, 'world', { allowNegative: true });
    const a = await createAccount(api, 'wallet:a');
    const b = await createAccount(api, 'wallet:b');
    await fund(api, world.id, a.id, '1000');
    await fund(api, world.id, b.id, '1000');

    const outcomes = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        outcome(
          createTransfer(env.appPool, tenantId, randomUUID(), {
            fromAccountId: i % 2 === 0 ? a.id : b.id,
            toAccountId: i % 2 === 0 ? b.id : a.id,
            amount: '1',
            currency: 'USD',
          }),
        ),
      ),
    );

    expect(countBy(outcomes)).toEqual({ created: 100 });
    expect(await balanceOf(api, a.id)).toBe('1000');
    expect(await balanceOf(api, b.id)).toBe('1000');
  });
});
