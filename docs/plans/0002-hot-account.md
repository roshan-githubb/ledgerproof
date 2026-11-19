# Plan 0002: measure the hot-account limit, fix it only if the numbers say so

Status: implemented. The baseline met the decision rule. Candidate 1 was measured and rejected (worse); candidate 2 shipped as ADR 0006. Results: [docs/perf/README.md](../perf/README.md).

## The question

ADR 0002 predicts a weak spot. Every top-up moves money out of the tenant's single funding account, and the transfer locks both accounts. So all top-ups for a tenant wait in line for one row lock, no matter how many servers or connections we add.

Is that real, and is it big enough to matter? Don't assume: measure.

## Method

One command (`pnpm --filter @ledgerproof/api perf <label>`) that:

1. Starts its own PostgreSQL 18, runs migrations, seeds one tenant with a funding account and two wallets per virtual user (each funded with plenty of money).
2. Starts the built API (`node dist/server.js`) with request logging off.
3. Runs two k6 scenarios with **identical load** (same virtual users, same duration), differing in exactly one thing:
   - **control**: each virtual user moves money back and forth between its own two wallets. No two concurrent transfers share a row.
   - **hot**: each virtual user tops up its own wallet from the one funding account. The funding account is the only shared row.

   (A first trial used random pairs among 200 wallets as the control. It still showed 25% lock waits, because random pairs collide often, so it wasn't a clean control. Changed before taking the baseline.)
4. Repeats both scenarios twice (control, hot, control, hot), so run-to-run noise is visible.
5. While each scenario runs, samples `pg_stat_activity` every 50ms to see what the database is actually waiting on (row locks, WAL flush, CPU).
6. Afterwards, runs the reconciliation check: the ledger must still be consistent after the load.
7. Writes the raw numbers to `docs/perf/<label>.json` and prints a table.

## Decision rule (set before seeing any numbers)

Fix it only if **both** hold:
- hot throughput is below 70% of control, and
- row-lock waits (`Lock:transactionid` / `Lock:tuple`) are a large share of the hot scenario's database waits.

Otherwise, record the numbers, keep the simple design, and update ADR 0002 with the evidence.

## Candidate fixes, simplest first

1. **Shorter critical section.** Lock the funding account last, right before COMMIT. Cheap, but the row is still held through the commit's disk flush, so the expected gain is small.
2. **No cached balance for `allow_negative` accounts.** These accounts are never balance-checked, so nothing needs to lock them. Their balance is computed from history when read. This removes the shared row entirely; the cost is a slower balance read for funding accounts.

Choose based on the baseline evidence; record the reasoning in ADR 0006.

## Correctness requirements for any fix

- All existing tests stay green, and the mutation check still catches every mutation.
- A new deterministic test: while one top-up is paused mid-transaction, a top-up to a different wallet from the same funding account must still complete. It fails if the funding account is locked.
- The reconciliation check passes after every load run.

## Changed during build

- The control scenario was redesigned after a 5-second trial (see Method).
- Candidate 1 was expected to give a small gain. It made hot throughput worse (MultiXact contention from foreign-key share locks), so it was rejected by measurement.
- The control scenario fell between runs in both the old and new code, so the baseline was re-run after the fix to separate laptop noise from real regressions.
- The history endpoint now checks account existence without computing a balance (`assertAccountExists`), so listing a funding account's history doesn't pay for an O(history) balance.

## Caveats, stated up front

A laptop: Windows 11, embedded PostgreSQL with default settings (fsync on), one Node process, and k6 on the same machine. The numbers are a **relative comparison** (control vs hot, before vs after) on identical setups, not a capacity claim for production.
