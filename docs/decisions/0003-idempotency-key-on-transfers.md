# ADR 0003: Idempotency keys stored on the transfer, serialized by an advisory lock

Status: accepted, 2026-11-19

## Context

Networks fail after the server has done the work but before the client hears back. The client can't tell "it failed" from "it worked and the response was lost", so it retries. Without protection, a retry moves the money twice.

## Decision

- `POST /v1/transfers` requires an `Idempotency-Key` header.
- The key and a SHA-256 **request hash** (of the normalized body) are stored on the transfer row, with `UNIQUE (tenant_id, idempotency_key)`.
- Inside the transfer's database transaction, the first step is `pg_advisory_xact_lock(hash(tenant, key))`. Requests with the same key run one at a time.
- Then: if a transfer with this key exists and the hash matches, return it (200 + `Idempotent-Replayed: true`). If the hash differs, return 409 `idempotency_key_reused`. Otherwise do the transfer.
- Only a **successful** transfer records the key. A request rejected for insufficient funds can be retried with the same key after funding; it still can't move money twice.

Because the key is written in the same transaction as the money movement, the two can never disagree. If the process crashes mid-way, both roll back and the retry starts clean. If the connection drops during COMMIT, the client retries: a replay if the commit happened, a fresh attempt if not.

## Why the advisory lock, if there's a unique constraint?

The unique constraint alone guarantees one row per key, but not the right **response**. Two identical requests arriving together both see "no transfer with this key yet". One commits. The other then waits for the account lock, finds the balance spent, and returns `insufficient_funds` to a client whose transfer actually succeeded. The advisory lock makes the second request wait until the first commits, so it finds the transfer and replays it. The unique constraint stays as the backstop.

## Alternatives rejected

- **A separate `idempotency_keys` table storing full responses** (Stripe's approach). More general: it can replay errors and cover endpoints with no natural row. Worth it once an endpoint has side effects outside Postgres. Today every side effect is one row in one transaction, so storing on the transfer is simpler and can't drift.
- **Redis or in-memory locks.** Not atomic with the commit, and they disappear on restart.
- **Natural keys only** (e.g. the tenant's order id). Not every transfer has one, and clients already know the header convention.

## Consequences and where it breaks

- **Keys never expire.** The table grows with every transfer anyway, so this costs little now. Later: a retention window, after which the same key could create a new transfer (document it, like Stripe's 24 hours).
- **A replay returns the stored transfer**, not a byte-for-byte copy of the original response. That's fine because the transfer resource is immutable.
- **External side effects** (paying out to a bank) would break this model, because the bank call can't be inside the database transaction. Phase 5 uses an outbox: commit the intent and the key together, then a worker performs the external call idempotently.
- Two different keys can hash to the same advisory lock id. That only makes them wait for each other; it can't merge them.

## Proof

`test/idempotency.test.ts`:
- a sequential retry replays (same id, money moves once)
- 20 concurrent identical requests: 1 created, 19 replayed, one row
- the same key with a different body gives 409, no second row
- a rejected request doesn't use up its key
- keys are scoped per tenant
- crash halfway (backend killed between insert and balance update): nothing persists, and the retry succeeds exactly once

The mutation check removes the advisory lock and the concurrent-duplicates test fails.
