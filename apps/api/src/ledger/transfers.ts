import type pg from 'pg';
import { withTenantTx, type Db } from '../db/tx.js';
import { badRequest, conflict, notFound, unprocessable } from '../errors.js';
import { parseAmount } from '../money.js';
import { findAccount } from './accounts.js';
import { requestHash } from './request-hash.js';

export interface Transfer {
  id: string;
  from_account_id: string;
  to_account_id: string;
  /** bigint minor units, as a decimal string. */
  amount: string;
  currency: string;
  description: string | null;
  metadata: Record<string, string>;
  created_at: Date;
}

export interface CreateTransferInput {
  fromAccountId: string;
  toAccountId: string;
  amount: string;
  currency: string;
  description?: string | null;
  metadata?: Record<string, string>;
}

/**
 * Test-only seams for failing at an exact point inside the transaction (see the crash test in
 * test/idempotency.test.ts). Production code never passes these.
 */
export interface TransferFaults {
  afterInsert?: (db: Db) => Promise<void>;
}

interface LockedAccount {
  id: string;
  currency: string;
  allow_negative: boolean;
  balance: string;
}

const COLUMNS =
  'id, from_account_id, to_account_id, amount, currency, description, metadata, created_at';

/**
 * Moves `amount` from one account to another, at most once per idempotency key.
 * Design and failure analysis: docs/plans/0001-core-ledger.md, ADRs 0002 and 0003.
 */
export async function createTransfer(
  pool: pg.Pool,
  tenantId: string,
  idempotencyKey: string,
  input: CreateTransferInput,
  faults?: TransferFaults,
): Promise<{ transfer: Transfer; replayed: boolean }> {
  // Normalize before hashing, so the same request always has the same fingerprint
  // (for example, upper- and lower-case spellings of one account id).
  const request = {
    from_account_id: input.fromAccountId.toLowerCase(),
    to_account_id: input.toAccountId.toLowerCase(),
    amount: parseAmount(input.amount).toString(),
    currency: input.currency,
    description: input.description ?? null,
    metadata: input.metadata ?? {},
  };
  if (request.from_account_id === request.to_account_id) {
    throw badRequest('same_account', 'from_account_id and to_account_id must be different');
  }
  const hash = requestHash(request);
  const amount = BigInt(request.amount);

  return withTenantTx(pool, tenantId, async (db) => {
    // 1. Requests that share a key run one at a time, whichever accounts they touch.
    //    Released automatically at COMMIT or ROLLBACK. A hash collision between two different
    //    keys only makes them wait for each other; it cannot merge them.
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `${tenantId}:${idempotencyKey}`,
    ]);

    // 2. A key we have seen before: replay the same request, reject a different one.
    const prior = await db.query<Transfer & { request_hash: string }>(
      `SELECT ${COLUMNS}, request_hash FROM transfers WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    if (prior.rows[0]) {
      const { request_hash: priorHash, ...transfer } = prior.rows[0];
      if (priorHash !== hash) {
        throw conflict(
          'idempotency_key_reused',
          'this Idempotency-Key was already used with a different request',
        );
      }
      return { transfer, replayed: true };
    }

    // 3. Lock both accounts, always in id order, so A->B and B->A cannot deadlock.
    //    FOR UPDATE waits for any in-flight transfer on these rows, then returns the latest
    //    committed balance, so the check below cannot act on a stale value.
    const locked = await db.query<LockedAccount>(
      `SELECT id, currency, allow_negative, balance
         FROM accounts
        WHERE id = ANY($1::uuid[])
        ORDER BY id
          FOR UPDATE`,
      [[request.from_account_id, request.to_account_id]],
    );
    const from = locked.rows.find((a) => a.id === request.from_account_id);
    const to = locked.rows.find((a) => a.id === request.to_account_id);
    if (!from) throw notFound('from account');
    if (!to) throw notFound('to account');

    // 4. Business rules, checked against the locked rows.
    if (from.currency !== request.currency || to.currency !== request.currency) {
      throw unprocessable(
        'currency_mismatch',
        'both accounts must have the same currency as the transfer',
      );
    }
    if (!from.allow_negative && BigInt(from.balance) < amount) {
      throw unprocessable('insufficient_funds', 'the from account balance is lower than the amount');
    }

    // 5. Write. The CHECK constraint on accounts.balance is the backstop for step 4, and the
    //    unique (tenant_id, idempotency_key) constraint is the backstop for steps 1 and 2.
    const inserted = await db.query<Transfer>(
      `INSERT INTO transfers
         (tenant_id, from_account_id, to_account_id, amount, currency,
          idempotency_key, request_hash, description, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
       RETURNING ${COLUMNS}`,
      [
        tenantId,
        request.from_account_id,
        request.to_account_id,
        request.amount,
        request.currency,
        idempotencyKey,
        hash,
        request.description,
        JSON.stringify(request.metadata),
      ],
    );
    await faults?.afterInsert?.(db);
    await db.query('UPDATE accounts SET balance = balance - $1 WHERE id = $2', [
      request.amount,
      from.id,
    ]);
    await db.query('UPDATE accounts SET balance = balance + $1 WHERE id = $2', [
      request.amount,
      to.id,
    ]);
    return { transfer: inserted.rows[0]!, replayed: false };
  });
}

export async function getTransfer(pool: pg.Pool, tenantId: string, id: string): Promise<Transfer> {
  return withTenantTx(pool, tenantId, async (db) => {
    const { rows } = await db.query<Transfer>(`SELECT ${COLUMNS} FROM transfers WHERE id = $1`, [
      id,
    ]);
    if (!rows[0]) throw notFound('transfer');
    return rows[0];
  });
}

/** An account's transfers, newest first. The cursor is the last row's seq from the prior page. */
export async function listAccountTransfers(
  pool: pg.Pool,
  tenantId: string,
  accountId: string,
  page: { limit: number; cursor: string | null },
): Promise<{ data: Transfer[]; next_cursor: string | null }> {
  return withTenantTx(pool, tenantId, async (db) => {
    await findAccount(db, accountId); // 404 rather than an empty list for unknown accounts
    const { rows } = await db.query<Transfer & { seq: string }>(
      `SELECT seq, ${COLUMNS}
         FROM transfers
        WHERE (from_account_id = $1 OR to_account_id = $1)
          AND ($2::bigint IS NULL OR seq < $2::bigint)
        ORDER BY seq DESC
        LIMIT $3`,
      [accountId, page.cursor, page.limit + 1],
    );
    const hasMore = rows.length > page.limit;
    const pageRows = rows.slice(0, page.limit);
    return {
      data: pageRows.map(({ seq: _seq, ...transfer }) => transfer),
      next_cursor: hasMore ? pageRows[pageRows.length - 1]!.seq : null,
    };
  });
}
