# ADR 0002: Concurrency control with row locks taken in id order

Status: accepted, 2026-11-19

## Context

Two transfers can spend from the same wallet at the same moment. If both read the balance before either writes, both pass the "enough money?" check and the wallet is overdrawn. That is the classic lost-update / write-skew problem.

## Decision

Inside one READ COMMITTED transaction:

```sql
SELECT id, currency, allow_negative, balance
  FROM accounts
 WHERE id = ANY($1)      -- both accounts
 ORDER BY id
   FOR UPDATE;
```

then check, insert the transfer, and update both balances.

- `FOR UPDATE` makes a second transfer on the same account **wait** until the first commits. After the wait, Postgres re-reads the row, so the check sees the latest committed balance.
- `ORDER BY id` means every transaction locks its accounts in the same global order. A→B and B→A can never each hold one lock while waiting for the other, so they cannot deadlock.
- A `CHECK (allow_negative OR balance >= 0)` constraint is the backstop. Even if the application check were wrong, the database refuses to overdraw.
- `statement_timeout = 5s` on the pool: no request waits on a lock forever.

## Alternatives rejected

- **SERIALIZABLE isolation + retry on 40001.** Correct, and it doesn't need explicit locks. But every caller must retry on serialization failures, retries multiply under contention, and failures surface as errors instead of waits. Pessimistic locks are simpler to reason about for a small, known set of rows per transaction.
- **Optimistic locking (version column, retry on mismatch).** Good for low contention. Wallets with bursts of spending are exactly the high-contention case, where optimistic retries spin.
- **Conditional UPDATE without a read** (`UPDATE ... SET balance = balance - $1 WHERE id = $2 AND balance >= $1`). Atomic and fast for the source account, and a reasonable alternative. We chose one locking read because we also need both rows' existence, currency and `allow_negative` to return precise errors, and the read gives us all of that in one place.
- **Application-level locks (Redis, mutex).** Another system to run, and not atomic with the database commit.

## Consequences and where it breaks

- **Hot accounts.** Every top-up for a tenant locked that tenant's single funding account, so top-ups ran one at a time per tenant. **Measured and fixed in [ADR 0006](0006-uncached-funding-balances.md):** before the fix, hot throughput was about 56% of control with 95% lock waits. Funding accounts now keep no cached balance, so they are never locked.
- **Long transactions hold locks.** Nothing slow (network calls, external APIs) may ever run inside this transaction. Payouts to banks will use an outbox (Phase 5).
- Locks only work inside one Postgres primary. Sharding accounts across databases would need a different design (and is far beyond this project's needs).

## Proof

- `test/concurrency.test.ts` "never overdraws": 50 concurrent 10-unit spends from 100 give exactly 10 successes and 40 `insufficient_funds`.
- `test/concurrency.test.ts` "does not deadlock": 100 concurrent transfers in both directions all succeed.
- `pnpm --filter @ledgerproof/api mutation-check`: removing `FOR UPDATE` fails the first test (13–14 stale reads caught only by the CHECK constraint). Locking in request order fails the second (transfers pile up and hit the 5s statement timeout).
