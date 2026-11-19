import type pg from 'pg';

export interface Violation {
  kind: 'balance_drift' | 'tenant_not_zero' | 'negative_balance';
  detail: string;
}

/**
 * Recomputes every balance from the transfer history and checks the ledger's invariants:
 * 1. each cached balance = sum(incoming) - sum(outgoing). Only checked accounts have one;
 *    allow_negative accounts are computed from history by definition (ADR 0006).
 * 2. each tenant's balances sum to zero per currency (money is never created or destroyed)
 * 3. no account without allow_negative is below zero
 * Runs on an owner connection (it reads across tenants). Used by tests now and by the nightly
 * reconciliation job later. Returns an empty list when the ledger is consistent.
 *
 * Loads one row per account into memory: fine at this scale. At millions of accounts this
 * becomes a streaming or SQL-side aggregation.
 */
export async function findViolations(adminPool: pg.Pool, tenantId?: string): Promise<Violation[]> {
  const { rows } = await adminPool.query<{
    id: string;
    tenant_id: string;
    currency: string;
    allow_negative: boolean;
    balance: string | null;
    from_history: string;
  }>(
    `SELECT a.id, a.tenant_id, a.currency, a.allow_negative, a.balance::text,
            (coalesce(i.total, 0) - coalesce(o.total, 0))::text AS from_history
       FROM accounts a
       LEFT JOIN (SELECT to_account_id AS id, sum(amount) AS total FROM transfers GROUP BY 1) i
              ON i.id = a.id
       LEFT JOIN (SELECT from_account_id AS id, sum(amount) AS total FROM transfers GROUP BY 1) o
              ON o.id = a.id
      ${tenantId ? 'WHERE a.tenant_id = $1' : ''}`,
    tenantId ? [tenantId] : [],
  );

  const violations: Violation[] = [];
  const totals = new Map<string, bigint>();
  for (const row of rows) {
    const fromHistory = BigInt(row.from_history);
    if (row.balance !== null && BigInt(row.balance) !== fromHistory) {
      violations.push({
        kind: 'balance_drift',
        detail: `account ${row.id}: balance ${row.balance}, transfers say ${row.from_history}`,
      });
    }
    const effective = row.balance !== null ? BigInt(row.balance) : fromHistory;
    if (!row.allow_negative && effective < 0n) {
      violations.push({ kind: 'negative_balance', detail: `account ${row.id}: ${effective}` });
    }
    const key = `${row.tenant_id} ${row.currency}`;
    totals.set(key, (totals.get(key) ?? 0n) + effective);
  }
  for (const [key, total] of totals) {
    if (total !== 0n) {
      violations.push({ kind: 'tenant_not_zero', detail: `tenant ${key}: balances sum to ${total}` });
    }
  }
  return violations;
}
