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
