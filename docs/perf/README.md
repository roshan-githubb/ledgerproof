# Performance results: the hot funding account

Plan and decision rule: [docs/plans/0002-hot-account.md](../plans/0002-hot-account.md). Decision: [ADR 0006](../decisions/0006-uncached-funding-balances.md).

## Reproduce

```bash
pnpm --filter @ledgerproof/api perf <label>
```

It starts its own PostgreSQL 18, seeds data, starts the built API, runs k6 (control vs hot, two rounds of 20 s at 32 virtual users), samples `pg_stat_activity`, checks ledger invariants, and writes `docs/perf/<label>.json`. It needs k6 on PATH, `K6_BIN`, or under `.tmp/tools/`.

**Scenarios.** Each virtual user owns two wallets, so the scenarios differ in exactly one thing:
- **control**: each VU moves money between its own two wallets. No shared rows.
- **hot**: each VU tops up its own wallet from the tenant's one funding account. The funding account is the only shared row.

**Machine.** Laptop, Intel i5-8365U (4 cores / 8 threads), 8 GB RAM, Windows 11, Node 22, PostgreSQL 18.6 (embedded, default settings: fsync on, synchronous_commit on). k6, the API and Postgres all run on the same machine. These numbers compare versions on identical setups; they are not production capacity.

## Results

Transfers per second are successful (201) transfers. Two rounds per scenario.

| Version | Scenario | Transfers/s | p50 ms | p95 ms | p99 ms | Top DB waits |
|---|---|---|---|---|---|---|
| **Before** (funding row locked for the whole transaction) | control | 839 / 809 | 37 / 39 | 44 / 45 | 54 / 49 | CPU, WAL |
| | hot | **472 / 456** | 33 / 34 | **379 / 401** | **563 / 594** | **Lock:tuple 85%, Lock:transactionid 10%** |
| Candidate 1 (lock funding row last), rejected | control | 780 / 735 | 41 / 43 | 46 / 48 | 54 / 51 | CPU, WAL |
| | hot | 396 / 276 | 61 / 81 | 203 / 324 | 433 / 682 | Lock:transactionid 55–58%, **LWLock:MultiXactMemberBuffer 18%**, BufferContent 13% |
| **After** (funding balance not cached, row never locked) | control | 758 / 657 | 41 / 48 | 48 / 54 | 55 / 64 | CPU, WAL |
| | hot | **811 / 721** | 39 / 44 | **44 / 50** | **50 / 59** | CPU 67%, no lock waits |
| Before, re-run after the others (noise check) | control | 832 / 653 | 38 / 49 | 43 / 55 | 49 / 61 | CPU, WAL |
| | hot | 437 / 403 | 36 / 39 | 416 / 229 | 838 / 1017 | Lock:tuple 85% |

Raw data: [before.json](before.json), [lock-last.json](lock-last.json), [after.json](after.json), [before-rerun.json](before-rerun.json).

## What the numbers say

1. **The hot account was real.** Before the fix, top-ups ran at about 56% of control throughput, and 95% of their database time was waiting for the funding row's lock. The median looked fine (33 ms); the **tail** was about 9× worse (p95 ~390 ms). Requests queued behind one row.
2. **The obvious cheap fix made it worse.** Locking the funding row only for the final update cut hot throughput by up to 40%. Many transactions then reached their insert at once, and each foreign-key check took a shared lock on the same funding row while another transaction was updating it. Postgres tracks multiple lockers on one row with MultiXacts, and MultiXact contention became the new bottleneck.
3. **Removing the shared row fixed it.** Top-ups no longer lock or update the funding account. Hot throughput rose 58–72%, p95 dropped about 8× (to 44–50 ms), and lock waits disappeared. Top-ups are now as fast as wallet-to-wallet transfers, because each locks only one row.
4. **Run-to-run noise on this laptop is large.** Control drops about 20% between rounds in both the original and the fixed code (832 → 653 in the re-run), most likely thermal throttling under sustained load. Differences in control between versions are within that noise. The hot-scenario change is far outside it.
5. **The ledger stayed correct.** 0 invariant violations after every run (about 30–50k transfers each).

## The cost, measured

The funding account's balance is now computed from its history on every read.

| | Funding account balance read (p50) | Wallet balance read (p50) |
|---|---|---|
| Before (cached), 16,910 funding transfers | 15.8 ms | 16.3 ms |
| After (computed), 30,743 funding transfers | **32.3 ms** | 14.7 ms |

That's about 17 ms extra at 30k transfers, and it grows with history. Fine for an internal account read by dashboards and reconciliation; not fine at millions of transfers. The follow-up is in ADR 0006.
