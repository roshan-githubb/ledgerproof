# Plan 0001: core ledger API

Status: implemented. Written before the code; the "Changed during build" section at the end records what changed and why.

## Goal

A Fastify API on Postgres where a tenant can create accounts, move money between them, and read balances and history, with the six promises in PRODUCT.md backed by tests that run against real Postgres.

## Data model

```
tenants    (id, name)
api_keys   (id, tenant_id, key_hash, revoked_at)          -- sha256 of the key; the key is never stored
accounts   (id, tenant_id, reference, currency, allow_negative, balance)
transfers  (seq, id, tenant_id, from_account_id, to_account_id, amount, currency,
            idempotency_key, request_hash, description, metadata, created_at)
```

- **The transfer is the unit of record.** One row = one amount leaving one account and entering another. Zero-sum is true by construction: an unbalanced transfer cannot be written. There is no separate journal-entries table (ADR 0001).
- `accounts.balance` is a cached sum, updated in the same database transaction as the transfer insert. It is checkable: balance = sum(incoming) - sum(outgoing).
- Money is `bigint` minor units. On the wire, amounts are decimal strings (ADR 0005).
- `transfers` is append-only: the app's database role has no UPDATE or DELETE privilege on it.

## API (v1)

All `/v1` routes need `Authorization: Bearer <api key>`. Errors are `{ "error": { "code", "message" } }`.

| Method | Path | Notes |
|---|---|---|
| POST | /v1/accounts | `{reference, currency, allow_negative?}`. 201 if created; 200 if the same reference already exists with the same settings; 409 if it exists with different settings |
| GET | /v1/accounts/:id | Includes `balance` |
| GET | /v1/accounts/:id/transfers | Newest first, `?limit` and `?cursor` |
| POST | /v1/transfers | Requires an `Idempotency-Key` header. `{from_account_id, to_account_id, amount, currency, description?, metadata?}`. 201 if new; 200 plus `Idempotent-Replayed: true` on a replay; 409 if the key was reused with a different body; 422 for insufficient funds or a currency mismatch |
| GET | /v1/transfers/:id | |
| GET | /health | Checks that the database answers |

## The transfer, step by step

One database transaction:

1. `set_config('app.tenant_id', $tenant, true)`: transaction-scoped tenant context for row-level security.
2. `pg_advisory_xact_lock(hash(tenant, idempotency key))`: requests that share a key run one at a time.
3. Look up an existing transfer with this key. If found: the same request hash means replay it; a different hash means 409.
4. `SELECT ... FROM accounts WHERE id IN (from, to) ORDER BY id FOR UPDATE`: lock both accounts, always in id order, so A→B and B→A cannot deadlock.
5. Check: both accounts exist (else 404), currencies match (else 422), the balance covers the amount unless `allow_negative` (else 422).
6. Insert the transfer. Update both balances.
7. Commit.

Why lock before checking: under READ COMMITTED, each statement sees the latest committed data, and `FOR UPDATE` re-reads the row after waiting for the lock. So the balance check in step 5 sees every transfer that committed before it got the lock.

## Isolation between tenants

- Row-level security on `tenants`, `accounts` and `transfers`, keyed on `app.tenant_id`. With no tenant set, the policy matches nothing (it fails closed).
- The API connects as `ledger_app` members: not the table owner, no BYPASSRLS. Only migrations and the admin CLI use the owner connection.
- Composite foreign keys `(tenant_id, account_id, currency)`: a transfer cannot point at another tenant's account, or an account in another currency, even from a connection that bypasses RLS.
- API keys are checked through a `SECURITY DEFINER` function. The app role cannot read the `api_keys` table.

## Failure behaviour

| Failure | What happens | Why it is safe |
|---|---|---|
| Two transfers spend the same wallet at once | The second waits for the first's row lock, then sees the new balance | Row lock + re-check; the CHECK constraint is a backstop |
| A→B and B→A at once | Both lock in id order; one waits, neither deadlocks | Deterministic lock order |
| Client retries the same request | Replayed from the stored transfer | Advisory lock + unique (tenant, key) |
| Two identical requests at the same instant | Serialized by the advisory lock; the second replays | Same |
| Process crashes after the insert, before the balance update | Postgres rolls back the whole transaction; the client retries with the same key | One transaction; nothing commits partially |
| Connection drops during COMMIT (outcome unknown to the client) | The client gets an error and retries with the same key: a replay if it committed, a fresh attempt if not | This is exactly the case idempotency keys exist for |
| Bug in app code skips the balance check | The CHECK `allow_negative OR balance >= 0` rejects the update | Defence in depth |
| Query without tenant context | Returns no rows | RLS policy compares against NULL |

## Tests (real Postgres; each would fail if its claim were false)

| Claim | Test |
|---|---|
| No overdraft under concurrency | 50 concurrent 10-unit transfers from a 100 balance: exactly 10 succeed, 40 get 422, no 500s, final balance 0 |
| No deadlocks | 100 concurrent transfers in both directions between two accounts all succeed |
| Duplicate requests create one transfer | 20 concurrent identical requests with one key: one 201, nineteen 200 replays, one row, balance moved once |
| Key reuse with a different body is rejected | 409, no second row |
| A crash halfway leaves nothing behind | Kill the backend between insert and balance update: no row, balances unchanged; the retry succeeds once |
| Tenant isolation (API) | Tenant B gets 404 on A's accounts and transfers, and cannot transfer from or to them |
| Tenant isolation (database) | Under B's context, A's rows are invisible and inserts for A fail; with no context nothing is visible; composite FKs reject cross-tenant rows even as owner |
| Append-only history | App role gets "permission denied" on UPDATE/DELETE of transfers |
| Invariants hold under random load | 200 concurrent random transfers, then: each balance = sum of its transfers; tenant total = 0; no non-negative account below 0 |
| Exact amounts | 9007199254740993 (2^53 + 1) round-trips exactly; JSON numbers and decimals are rejected |

## Out of scope

Pending/two-step transfers, refunds linked to originals, batches, webhooks, dashboard, assistant, rate limiting, deployment. See the PRODUCT.md roadmap.

## Known risk: hot accounts

Every top-up locks the tenant's single funding account, so top-ups for one tenant run one at a time. This is fine until it isn't. Roadmap Phase 2 measures it with k6 before changing anything.

## Changed during build

Details in docs/ai-workflow-log.md.

- **Concurrency proof tests call the ledger directly**, with a fault-injection pause between the balance check and the write. Through HTTP, the races appeared only occasionally in tests, so a missing lock could still pass. The mutation check found this.
- **Test pools are warmed** (every connection opened up front). A cold pool staggered "concurrent" transactions.
- **Added `scripts/mutation-check.ts`**: deliberately breaks each guarantee and expects its test to fail.
- **Added `src/ledger/reconcile.ts`** (`findViolations`), used by the invariants test and later by the nightly reconciliation job.
- **Composite FK includes currency**, `(tenant_id, account_id, currency)`, so a currency mismatch is impossible at the schema level too, not only in application code.
- **Known slow spot noted**: account history uses `from = X OR to = X`. Measure in Phase 2 before changing it.
