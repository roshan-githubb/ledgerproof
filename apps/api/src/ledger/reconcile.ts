import type pg from 'pg';

export interface Violation {
  kind: 'balance_drift' | 'tenant_not_zero' | 'negative_balance';
  detail: string;
}

/**
 * Recomputes every balance from the transfer history and checks the ledger's invariants:
 * 1. each account's cached balance = sum(incoming) - sum(outgoing)
 * 2. each tenant's balances sum to zero per currency (money is never created or destroyed)
 * 3. no account without allow_negative is below zero
 * Runs on an owner connection (it reads across tenants). Used by tests now and by the nightly
 * reconciliation job later. Returns an empty list when the ledger is consistent.
 */
export async function findViolations(adminPool: pg.Pool, tenantId?: string): Promise<Violation[]> {
  const violations: Violation[] = [];
  const scope = tenantId ? 'WHERE a.tenant_id = $1' : '';
  const params = tenantId ? [tenantId] : [];

  const drift = await adminPool.query<{ id: string; balance: string; computed: string }>(
    `SELECT a.id, a.balance::text, (coalesce(i.total, 0) - coalesce(o.total, 0))::text AS computed
       FROM accounts a
       LEFT JOIN (SELECT to_account_id AS id, sum(amount) AS total FROM transfers GROUP BY 1) i
              ON i.id = a.id
       LEFT JOIN (SELECT from_account_id AS id, sum(amount) AS total FROM transfers GROUP BY 1) o
              ON o.id = a.id
       ${scope}`,
    params,
  );
  for (const row of drift.rows) {
    if (BigInt(row.balance) !== BigInt(row.computed)) {
      violations.push({
        kind: 'balance_drift',
        detail: `account ${row.id}: balance ${row.balance}, transfers say ${row.computed}`,
      });
    }
  }

  const totals = await adminPool.query<{ tenant_id: string; currency: string; total: string }>(
    `SELECT a.tenant_id, a.currency, sum(a.balance)::text AS total
       FROM accounts a ${scope}
      GROUP BY 1, 2
     HAVING sum(a.balance) <> 0`,
    params,
  );
  for (const row of totals.rows) {
    violations.push({
      kind: 'tenant_not_zero',
      detail: `tenant ${row.tenant_id} ${row.currency}: balances sum to ${row.total}`,
    });
  }

  const negative = await adminPool.query<{ id: string; balance: string }>(
    `SELECT a.id, a.balance::text FROM accounts a
      WHERE NOT a.allow_negative AND a.balance < 0 ${tenantId ? 'AND a.tenant_id = $1' : ''}`,
    params,
  );
  for (const row of negative.rows) {
    violations.push({ kind: 'negative_balance', detail: `account ${row.id}: ${row.balance}` });
  }

  return violations;
}
