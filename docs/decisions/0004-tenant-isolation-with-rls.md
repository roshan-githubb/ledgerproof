# ADR 0004: Tenant isolation enforced by the database

Status: accepted, 2026-11-19

## Context

All tenants share the same tables. The usual approach is adding `WHERE tenant_id = $1` to every query, which works until one query forgets it. In a payments ledger, that one forgotten clause shows one business another business's money.

## Decision

Four layers, each enforced by Postgres rather than by convention:

1. **Row-level security** on `tenants`, `accounts` and `transfers`. The policy compares `tenant_id` with `app_tenant_id()`, which reads a setting the API sets at the start of each transaction.
2. **Transaction-scoped tenant context.** `withTenantTx()` runs `set_config('app.tenant_id', $1, true)`. The `true` makes it revert at COMMIT/ROLLBACK, so a pooled connection never carries one tenant's context into the next request. It is the only way request code gets a connection. With no tenant set, `app_tenant_id()` is NULL and every policy matches nothing: **fail closed**.
3. **Least-privilege role.** The API logs in as a member of `ledger_app`. It is not the table owner (owners bypass RLS) and has no BYPASSRLS. It can't read `api_keys`, can't change any account column except `balance`, and can't UPDATE or DELETE transfers.
4. **Composite foreign keys** `(tenant_id, account_id, currency)`. A transfer can't reference another tenant's account, or an account in a different currency, even from an owner connection that bypasses RLS.

API keys are random 256-bit values. We store only their SHA-256 hash (a slow password hash isn't needed for random keys) and check them through a `SECURITY DEFINER` function.

## Alternatives rejected

- **Application WHERE clauses only.** No safety net for the query someone forgets.
- **Schema per tenant or database per tenant.** Stronger physical isolation and easy per-tenant restore. But N copies to migrate, N connection pools, and cross-tenant operations (reconciliation, admin) get hard. Right for a few large enterprise tenants with contractual isolation needs; wrong for many small ones.

## Consequences and where it breaks

- **Owner connections bypass RLS.** Only migrations and the admin CLI use them. If someone runs the API with the owner URL, isolation silently degrades to "whatever the queries filter". A startup check that refuses to run as owner would close this; not built yet.
- **Session-level `SET` would leak.** Using `SET app.tenant_id` (no LOCAL) on a pooled connection would leak across requests. That's why the code uses the transaction-scoped form, and why this also works behind PgBouncer in transaction mode.
- **Policy cost.** RLS adds a predicate to every query. The indexes lead with `tenant_id`, so it should be cheap; Phase 2 measures it rather than assuming.
- **Error codes.** Another tenant's account returns 404, not 403, so callers can't probe which ids exist.

## Proof

`test/tenant-isolation.test.ts`:
- through the API: tenant B gets 404 on A's accounts, history and transfers, and can't move money from or to them
- in the database, as the app role: A's rows are invisible under B's context; writing a row for A is rejected by RLS; updating A's rows affects 0 rows; with no context nothing is visible; `api_keys` is permission denied
- the composite FK rejects a cross-tenant transfer even from the owner
- the app role can't update or delete transfers, change an account's currency, or delete accounts

The mutation check turns RLS off for `accounts` and 5 isolation tests fail.
