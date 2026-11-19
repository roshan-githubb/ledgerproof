# ADR 0006: Funding accounts don't cache a balance, so they are never locked

Status: accepted, 2026-11-19. Supersedes the "hot accounts" consequence in ADR 0002.

## Context

Every top-up moves money out of the tenant's single funding account (`allow_negative = true`). In the original design (ADR 0002), each transfer locked both accounts with `FOR UPDATE` and updated both cached balances. So every top-up for a tenant waited in line for one row.

Measured ([docs/perf](../perf/README.md)), with the same load against independent wallets as the control:
- hot throughput was about 56% of control
- hot p95 was about 9× worse (379–401 ms vs 44 ms)
- 95% of the hot scenario's database time was spent waiting on row locks

This met the decision rule set before measuring (plan 0002), so a fix was justified.

## Decision

`allow_negative` accounts keep **no cached balance** (`balance IS NULL`, enforced by a CHECK). Their balance is computed from transfer history when read.

The reasoning: we lock an account only to check its balance, and an `allow_negative` account is never checked. If it also isn't updated, nothing needs its row at all. Transfers now lock and update only the accounts that are balance-checked, still in id order. Top-ups from one funding account no longer wait for each other.

Migration `0002` is safe to run while old code is still serving: old code adding to a NULL balance leaves it NULL, and never checks it.

## Alternatives

- **Lock the funding row last** (hold it only for the final UPDATE and COMMIT). Tried and measured: **worse**, with hot throughput down to 276–396/s. With the row lock no longer making transactions wait at the start, many reached their insert at once. Each foreign-key check took a shared lock on the funding row while another transaction held it for update, and Postgres's MultiXact machinery (which tracks multiple lockers of one row) became the bottleneck (`LWLock:MultiXactMemberBuffer`). Rejected by measurement.
- **Split the funding account into N sub-accounts** and pick one per transfer. Reduces contention N-fold but doesn't remove it, and every read and report must sum the shards. More moving parts for less gain.
- **Append-only balance deltas, folded in by a worker.** Keeps O(1) reads and no hot row, but needs a background job, and balances become "cached value + pending deltas". Worth it if computed reads get too slow (see below).
- **SERIALIZABLE isolation.** Doesn't help: the conflict is real, so transactions would fail and retry instead of waiting.

## Consequences and where it breaks

- **Funding balance reads are O(history).** Measured: 32 ms p50 at 30,743 transfers, vs 15.8 ms when cached. This grows linearly. **Follow-up when it matters:** store a periodic snapshot (balance as of transfer `seq` N) and add only the transfers after it. Or, cheaper first, a covering index `INCLUDE (amount)` so the sum is an index-only scan. Measure before choosing.
- **Foreign-key share locks on the funding row remain.** Every insert still takes a shared lock on the funding row for its foreign-key check. At 32 concurrent users this didn't show up in the top waits, because there's no conflicting updater any more. At much higher concurrency, MultiXact traffic could return. Next experiment if we push load further: more VUs, watching the MultiXact waits.
- **Reconciliation changed.** Drift is checked only for cached balances; tenant totals use cached or computed balances (`findViolations`).
- **"allow_negative" now also means "uncached".** That's right for funding and system accounts. If a customer-facing account ever needs to go negative (a credit line), it would need a cached balance and a different flag.

## Proof

- `test/concurrency.test.ts`, "top-ups from one funding account do not wait for each other": one top-up is paused just before COMMIT while a second, from the same funding account, must finish. The mutation check puts the funding update back, and this test fails with "second blocked behind the first".
- All earlier tests and mutations still pass (43 tests, 8/8 mutations caught).
- `docs/perf/after.json`: hot 811 / 721 transfers/s, p95 44 / 50 ms, no lock waits, 0 invariant violations.
