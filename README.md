# Ledgerproof

A multi-tenant payments ledger API. Businesses use it to hold money for their customers (wallet balances, credits, payouts, refunds) without losing, duplicating or leaking a single minor unit.

Built to show design, judgment and proof: a written plan before code, decision records, and a test for every correctness claim. Each test is itself checked by a mutation script that breaks the guarantee and expects the test to fail.

- Product: [PRODUCT.md](PRODUCT.md)
- Plan: [docs/plans/0001-core-ledger.md](docs/plans/0001-core-ledger.md)
- Decisions: [docs/decisions/](docs/decisions/)
- How AI-written code is checked, and where the agent was wrong: [docs/ai-workflow-log.md](docs/ai-workflow-log.md)

## Guarantees and their proof

| Guarantee | How | Test | Mutation that makes it fail |
|---|---|---|---|
| No overdraft under concurrency | Row locks (`FOR UPDATE`) + CHECK constraint ([ADR 0002](docs/decisions/0002-concurrency-row-locks-in-id-order.md)) | [concurrency.test.ts](apps/api/test/concurrency.test.ts) | Drop `FOR UPDATE`; skip the app balance check |
| No deadlocks | Accounts always locked in id order | [concurrency.test.ts](apps/api/test/concurrency.test.ts) | Lock in request order |
| Retries never move money twice | Idempotency key + request hash, advisory lock, unique constraint ([ADR 0003](docs/decisions/0003-idempotency-key-on-transfers.md)) | [idempotency.test.ts](apps/api/test/idempotency.test.ts) | Remove the advisory lock |
| A crash halfway leaves nothing behind | One database transaction per transfer | [idempotency.test.ts](apps/api/test/idempotency.test.ts) (kills the DB connection mid-transfer) | Commit the row before the balance update |
| Tenants can't see or move each other's money | RLS + non-owner role + composite FKs ([ADR 0004](docs/decisions/0004-tenant-isolation-with-rls.md)) | [tenant-isolation.test.ts](apps/api/test/tenant-isolation.test.ts) | Turn RLS off for accounts |
| Money is never created or destroyed | Transfer = one row, zero-sum by construction ([ADR 0001](docs/decisions/0001-transfer-as-unit-of-record.md)) | [invariants.test.ts](apps/api/test/invariants.test.ts) (200 random concurrent transfers) | n/a; the checker itself is tested against a corrupted balance |
| Amounts are exact | bigint minor units, strings on the wire, no type coercion ([ADR 0005](docs/decisions/0005-money-as-bigint-strings.md)) | [api.test.ts](apps/api/test/api.test.ts) (2^53 + 1 round-trips) | Fastify's default type coercion |
| History is append-only | App role has no UPDATE/DELETE on transfers | [tenant-isolation.test.ts](apps/api/test/tenant-isolation.test.ts) | n/a |

## Run it

Requires Node 22+ and pnpm 10. Docker is optional.

```bash
pnpm install
```

### Tests (real Postgres)

```bash
pnpm --filter @ledgerproof/api test
```

The suite starts its own PostgreSQL 18: through Testcontainers if Docker is running, otherwise through [embedded-postgres](https://github.com/leinelissen/embedded-postgres) (the official binaries as a local process). Set `TEST_DATABASE_URL` to use your own throwaway database instead.

Prove the tests can fail (about 2 minutes):

```bash
pnpm --filter @ledgerproof/api mutation-check
```

### Local server

Terminal 1, a local Postgres with migrations applied (stays running; Ctrl+C stops it):

```bash
pnpm --filter @ledgerproof/api dev-db
```

Terminal 2, create a tenant and start the API:

```bash
ADMIN_DATABASE_URL=postgres://postgres:postgres@localhost:5432/ledgerproof pnpm --filter @ledgerproof/api create-tenant "Acme Ltd"
```

```bash
DATABASE_URL=postgres://ledger_api:ledger_api@localhost:5432/ledgerproof pnpm --filter @ledgerproof/api dev
```

### Try it

```bash
export KEY=lp_...   # printed by create-tenant
```

```bash
curl -s localhost:3000/v1/accounts -H "authorization: Bearer $KEY" -H 'content-type: application/json' -d '{"reference":"funding","currency":"USD","allow_negative":true}'
```

```bash
curl -s localhost:3000/v1/accounts -H "authorization: Bearer $KEY" -H 'content-type: application/json' -d '{"reference":"wallet:cus_123","currency":"USD"}'
```

```bash
curl -s localhost:3000/v1/transfers -H "authorization: Bearer $KEY" -H 'content-type: application/json' -H 'idempotency-key: topup-001' -d '{"from_account_id":"<funding id>","to_account_id":"<wallet id>","amount":"1500","currency":"USD"}'
```

Send the same transfer again and you get `200` with `Idempotent-Replayed: true`, and the same transfer id.

## API

| Method | Path | |
|---|---|---|
| POST | `/v1/accounts` | `{reference, currency, allow_negative?}`. 201 created, 200 already exists (same settings), 409 conflict |
| GET | `/v1/accounts/:id` | Account with `balance` |
| GET | `/v1/accounts/:id/transfers` | Newest first; `?limit=1..100&cursor=` |
| POST | `/v1/transfers` | Header `Idempotency-Key`. `{from_account_id, to_account_id, amount, currency, description?, metadata?}`. 201 / 200 replay / 409 key reused / 422 `insufficient_funds` or `currency_mismatch` |
| GET | `/v1/transfers/:id` | |
| GET | `/health` | |

Amounts are strings of integer minor units: `"1500"` is 15.00. Errors look like `{"error":{"code":"insufficient_funds","message":"..."}}`.

## Layout

```
apps/api/
  migrations/0001_init.sql   schema, RLS policies, role privileges
  src/ledger/transfers.ts    the transfer transaction (locking + idempotency)
  src/db/tx.ts               withTenantTx: the only way request code gets a connection
  src/ledger/reconcile.ts    recomputes balances from history; finds invariant violations
  src/http/v1.ts             routes and request schemas
  test/                      correctness tests against real Postgres
  scripts/mutation-check.ts  breaks each guarantee and expects its test to fail
```

## Status

Phase 1 (core ledger API) is done. Next: measuring the hot-account limit with k6, then an AI assistant whose numbers come only from the ledger. See the [roadmap](PRODUCT.md#roadmap).
