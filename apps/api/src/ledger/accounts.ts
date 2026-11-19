import type pg from 'pg';
import { withTenantTx, type Db } from '../db/tx.js';
import { conflict, notFound } from '../errors.js';

export interface Account {
  id: string;
  reference: string;
  currency: string;
  allow_negative: boolean;
  /** bigint minor units, as a decimal string (node-postgres returns int8 as string). */
  balance: string;
  created_at: Date;
}

export interface CreateAccountInput {
  reference: string;
  currency: string;
  allowNegative: boolean;
}

const COLUMNS = 'id, reference, currency, allow_negative, balance, created_at';

/**
 * Creating an account is idempotent on its reference: repeating the same request returns the
 * existing account, and the same reference with different settings is a conflict.
 */
export async function createAccount(
  pool: pg.Pool,
  tenantId: string,
  input: CreateAccountInput,
): Promise<{ account: Account; created: boolean }> {
  return withTenantTx(pool, tenantId, async (db) => {
    const inserted = await db.query<Account>(
      `INSERT INTO accounts (tenant_id, reference, currency, allow_negative)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, reference) DO NOTHING
       RETURNING ${COLUMNS}`,
      [tenantId, input.reference, input.currency, input.allowNegative],
    );
    if (inserted.rows[0]) return { account: inserted.rows[0], created: true };

    // A concurrent insert of the same reference makes ON CONFLICT wait for it to commit,
    // and this new statement (READ COMMITTED) then sees the committed row.
    const existing = await db.query<Account>(
      `SELECT ${COLUMNS} FROM accounts WHERE reference = $1`,
      [input.reference],
    );
    const account = existing.rows[0]!;
    if (account.currency !== input.currency || account.allow_negative !== input.allowNegative) {
      throw conflict(
        'account_reference_conflict',
        `an account with reference "${input.reference}" already exists with different settings`,
      );
    }
    return { account, created: false };
  });
}

export async function getAccount(pool: pg.Pool, tenantId: string, id: string): Promise<Account> {
  return withTenantTx(pool, tenantId, (db) => findAccount(db, id));
}

/** Row-level security limits this to the current tenant: another tenant's id is "not found". */
export async function findAccount(db: Db, id: string): Promise<Account> {
  const { rows } = await db.query<Account>(`SELECT ${COLUMNS} FROM accounts WHERE id = $1`, [id]);
  if (!rows[0]) throw notFound('account');
  return rows[0];
}
