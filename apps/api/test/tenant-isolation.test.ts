import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asAppRole, balanceOf, createAccount, fund, newTenant, startTestEnv, type TestEnv } from './helpers.js';

describe('tenant isolation', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await startTestEnv();
  });
  afterAll(async () => {
    await env.close();
  });

  /** Tenant A with a funded wallet and one transfer; tenant B with its own funded wallet. */
  async function twoTenants() {
    const a = await newTenant(env, 'a');
    const aWorld = await createAccount(a.api, 'world', { allowNegative: true });
    const aWallet = await createAccount(a.api, 'wallet:shared-ref');
    await fund(a.api, aWorld.id, aWallet.id, '500');
    const aTransfers = await a.api.get(`/v1/accounts/${aWallet.id}/transfers`);
    const aTransferId: string = aTransfers.json().data[0].id;

    const b = await newTenant(env, 'b');
    const bWorld = await createAccount(b.api, 'world', { allowNegative: true });
    const bWallet = await createAccount(b.api, 'wallet:shared-ref'); // same reference, separate namespace
    await fund(b.api, bWorld.id, bWallet.id, '500');
    return { a, aWallet, aTransferId, b, bWallet };
  }

  describe('through the API', () => {
    it("returns 404 for another tenant's account, history and transfer", async () => {
      const { b, aWallet, aTransferId } = await twoTenants();

      expect((await b.api.get(`/v1/accounts/${aWallet.id}`)).statusCode).toBe(404);
      expect((await b.api.get(`/v1/accounts/${aWallet.id}/transfers`)).statusCode).toBe(404);
      expect((await b.api.get(`/v1/transfers/${aTransferId}`)).statusCode).toBe(404);
    });

    it("cannot move money out of or into another tenant's account", async () => {
      const { a, aWallet, b, bWallet } = await twoTenants();

      const steal = await b.api.transfer({
        from_account_id: aWallet.id,
        to_account_id: bWallet.id,
        amount: '100',
        currency: 'USD',
      });
      const push = await b.api.transfer({
        from_account_id: bWallet.id,
        to_account_id: aWallet.id,
        amount: '100',
        currency: 'USD',
      });

      expect(steal.statusCode).toBe(404);
      expect(push.statusCode).toBe(404);
      expect(await balanceOf(a.api, aWallet.id)).toBe('500');
      expect(await balanceOf(b.api, bWallet.id)).toBe('500');
    });
  });

  // The API tests above would also pass if every query happened to filter by tenant. These
  // prove the database itself enforces isolation, for any query the app might ever run.
  describe('in the database (app role, row-level security)', () => {
    it("hides another tenant's rows completely", async () => {
      const { a, b } = await twoTenants();

      const seen = await asAppRole(env.appPool, b.tenantId, async (db) => {
        const accounts = await db.query('SELECT 1 FROM accounts WHERE tenant_id = $1', [a.tenantId]);
        const transfers = await db.query('SELECT 1 FROM transfers WHERE tenant_id = $1', [a.tenantId]);
        const tenants = await db.query('SELECT 1 FROM tenants WHERE id = $1', [a.tenantId]);
        return accounts.rowCount! + transfers.rowCount! + tenants.rowCount!;
      });

      expect(seen).toBe(0);
    });

    it("rejects writing a row for another tenant, and updates to its rows affect nothing", async () => {
      const { a, aWallet, b } = await twoTenants();

      await expect(
        asAppRole(env.appPool, b.tenantId, (db) =>
          db.query("INSERT INTO accounts (tenant_id, reference, currency) VALUES ($1, 'x', 'USD')", [
            a.tenantId,
          ]),
        ),
      ).rejects.toThrow(/row-level security/);

      const updated = await asAppRole(env.appPool, b.tenantId, (db) =>
        db.query('UPDATE accounts SET balance = 0 WHERE id = $1', [aWallet.id]),
      );
      expect(updated.rowCount).toBe(0);
    });

    it('fails closed: with no tenant set, nothing is visible', async () => {
      await twoTenants();

      const visible = await asAppRole(env.appPool, null, async (db) => {
        const { rows } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM accounts');
        return rows[0]!.n;
      });
      const total = await env.adminPool.query<{ n: number }>('SELECT count(*)::int AS n FROM accounts');

      expect(total.rows[0]!.n).toBeGreaterThan(0);
      expect(visible).toBe(0);
    });

    it('cannot read API keys at all', async () => {
      await expect(
        asAppRole(env.appPool, null, (db) => db.query('SELECT * FROM api_keys')),
      ).rejects.toThrow(/permission denied/);
    });

    it('composite foreign keys reject a cross-tenant transfer even from the owner, which bypasses RLS', async () => {
      const { aWallet, b, bWallet } = await twoTenants();

      await expect(
        env.adminPool.query(
          `INSERT INTO transfers (tenant_id, from_account_id, to_account_id, amount, currency,
                                  idempotency_key, request_hash)
           VALUES ($1, $2, $3, 1, 'USD', $4, 'x')`,
          [b.tenantId, aWallet.id, bWallet.id, randomUUID()],
        ),
      ).rejects.toThrow(/foreign key/);
    });
  });

  describe('append-only history (app role privileges)', () => {
    it.each([
      ['update a transfer', 'UPDATE transfers SET amount = 1'],
      ['delete a transfer', 'DELETE FROM transfers'],
      ['change an account currency', "UPDATE accounts SET currency = 'EUR'"],
      ['delete an account', 'DELETE FROM accounts'],
    ])('cannot %s', async (_label, sql) => {
      const { b } = await twoTenants();
      await expect(asAppRole(env.appPool, b.tenantId, (db) => db.query(sql))).rejects.toThrow(
        /permission denied/,
      );
    });
  });
});
