# AI workflow log

How this project is built with an AI coding agent (Claude Code), what was checked, and where the agent was wrong. The agent writes drafts; I own what ships. This log is the evidence of how I check.

## How I check AI-written code

1. **Plan first.** The agent writes the plan in `docs/plans/` before any code, and I review the design there, where changes are cheap.
2. **Real Postgres only.** Concurrency, locking and RLS behave differently on mocks, so every test runs against a real PostgreSQL 18 (Testcontainers, or embedded-postgres without Docker).
3. **Every claim gets a test that would fail if the claim were false.**
4. **Then I prove the test can fail.** `pnpm --filter @ledgerproof/api mutation-check` deliberately breaks each guarantee (drops a lock, turns RLS off, splits a transaction...) and expects the matching test to go red. A green test that stays green with the guarantee removed proves nothing.
5. **Run the thing.** Tests don't cover the server entry point, the CLI scripts or the build, so every feature ends with an end-to-end run of the README quickstart.

---

## 2026-11-19: Phase 1, core ledger API

**Agent did:** wrote PRODUCT.md, plan 0001, the schema, the transfer/idempotency/isolation logic, 42 tests, the mutation check, ADRs 0001–0005 and this README.

**Verified:**
- 42/42 tests pass on PostgreSQL 18.6 (embedded; this machine has no Docker).
- Mutation check: **7/7** deliberate bugs caught, on two consecutive runs.
- End to end: `dev-db` → `create-tenant` → `node dist/server.js` → real HTTP. Top-up 201, retry 200 + `Idempotent-Replayed`, overdraw 422, no key 401.
- A normal test run leaves no Postgres processes behind.

**Not verified yet:**
- The Testcontainers path (needs Docker; CI will run it).
- Any performance number. None are claimed.

### Where the agent was wrong

**1. Two "proof" tests didn't prove anything (found by the mutation check).**
The first mutation run caught only 5 of 7 bugs. With `FOR UPDATE` removed, the no-overdraft test still passed. With the idempotency advisory lock removed, the concurrent-duplicates test still passed. The agent had written comments claiming both tests would fail. They didn't.

Investigation, measured rather than guessed:
- Calling `createTransfer` directly with `FOR UPDATE` removed showed the race is real: 13–14 of 50 transfers passed the balance check on a stale balance, and only the CHECK constraint stopped them (Postgres error 23514).
- Through HTTP, the same scenario came back clean on one run and with a single 500 on another. The requests were spread out enough that they rarely overlapped at the critical moment. Per-request work before the transaction (the API-key lookup on the shared pool, opening new connections) is the likely cause; I didn't isolate which.
- A cold connection pool turned out to be a second, separate cause. A test that runs after another in the same file starts with only one or two open connections, so the first "concurrent" duplicate finished before the others had a connection.

Fix:
- The two proof tests call the ledger directly, with a fault-injection pause between the balance check and the write (`widenRaceWindow`). With correct locking the pause only slows the test; with a missing lock, the race happens every time.
- The test setup opens every pool connection up front.
- The HTTP path stays covered end to end by the 200-request invariants test.

Result: 7/7 caught, twice in a row.

Lesson: a concurrency test that relies on timing luck is a flaky detector. Make the race window deterministic, then prove the test fails without the fix.

**2. A mislabelled mutation.** The agent named one mutation "drop the CHECK backstop and the app check", but it only removed the app check. It was caught because the CHECK constraint turned the overdraft into a 500. Renamed to say what it does.

**3. Library defaults that are wrong for money (caught at design time, then proven).** Fastify's validator defaults to `coerceTypes` and `removeAdditional`. With those, the JSON number `9007199254740993` is accepted as `"9007199254740992"`, so one unit is lost silently. Both are turned off in `app.ts`, and the mutation check confirms the test fails if coercion comes back (201 instead of 400).

**4. Smaller things.**
- `pnpm add` rewrote package.json and dropped an edit made just before it (the `start` script path). Re-applied.
- A diagnostic test run was cut short in Vitest teardown and left an orphaned Postgres worker process. Found by checking for leftover processes; stopped. Normal runs verified clean.
- The agent's quickstart smoke script resolved the `pg_ctl` path wrongly in its cleanup step. Caught because it printed a failure instead of "ok"; Postgres was stopped by hand.

### Open questions I still want to answer
- With accounts locked in request order, the deadlock test failed mostly with statement timeouts (57014) rather than plain deadlock errors (40P01). My hypothesis: each deadlock costs Postgres's 1s `deadlock_timeout` to detect, and the queue behind several of them passes the 5s statement timeout. Not confirmed yet.

---

## 2026-11-19: Phase 2, the hot funding account

**Agent did:** wrote plan 0002 with a decision rule set before measuring; built the one-command load test (`pnpm perf`: embedded Postgres + built API + k6 + `pg_stat_activity` sampling + invariant check); measured the baseline; tried two fixes; shipped ADR 0006 (funding accounts keep no cached balance) with migration 0002; added a deterministic test and an 8th mutation.

**Verified:**
- Baseline: hot was 56% of control throughput, p95 about 9× worse, 95% row-lock waits. Met the decision rule.
- After: hot 811 / 721 transfers/s (was 472 / 456), p95 44 / 50 ms (was 379 / 401), no lock waits. 0 invariant violations in every run.
- Cost measured: funding balance read 32 ms at 30,743 transfers (was 16 ms cached).
- 43/43 tests, 8/8 mutations caught.
- k6 v2.3.0 downloaded from Grafana's GitHub releases, SHA-256 checked against the published checksums.

### Where the agent was wrong

**1. The first control scenario was a bad control.** Random pairs among 200 wallets still showed 25% lock waits in a trial run: with about 40 wallets locked at any moment, roughly a third of transfers collide. Redesigned before the baseline so each virtual user owns its own wallets, making the shared funding row the only difference between scenarios.

**2. The agent predicted the cheap fix would help a little. It made things worse.** Locking the funding row last cut hot throughput to 396 / 276 transfers/s. The wait events showed why: MultiXact and buffer-content contention, caused by many foreign-key share locks piling onto the funding row while one transaction updated it. Without the measurement, this "obviously better" change would have shipped.

**3. A regression that wasn't.** Control throughput fell from 839/809 (before) to 758/657 (after). Instead of explaining it away, the baseline code was re-run on the same machine afterwards: it also fell from 832 to 653 between rounds. The drop is laptop noise (most likely heat throttling), not the fix. Recorded as a caveat: version-to-version differences in control are within noise here.

### Open questions
- Does MultiXact contention from foreign-key share locks come back at higher concurrency, now that there's no updater on the funding row? Next experiment: raise VUs and watch the MultiXact waits.
- When should the computed funding balance become a snapshot plus a delta? Decide from read-latency numbers as history grows.
