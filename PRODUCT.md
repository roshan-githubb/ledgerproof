# Ledgerproof: product

## In one line

A ledger API that lets a business hold money for its customers (wallet balances, credits, payouts, refunds) without losing, duplicating or leaking a single minor unit. Later it adds a dashboard and an AI assistant that answer questions from the ledger itself.

## Who it is for

**Primary user: the tenant's backend developer.** A tenant is a business that holds money on behalf of its own customers: a marketplace paying out sellers, an app with in-app wallets, a platform issuing credits. The developer integrates first. Everything else (the dashboard, the assistant) reads data that their integration writes. If the API is not trustworthy, nothing built on top of it matters, so the API is what we build first.

**Secondary: the tenant's finance and ops staff.** They need to see balances and history, reconcile against the bank, and answer "where did this customer's money go?" without asking an engineer to run SQL.

**Later: ops staff and end customers asking the AI assistant.** "Why is my balance 40 lower than yesterday?" The assistant must answer with numbers that come from the ledger, never from the model.

## The problem we solve

Every business that holds customer money ends up building a ledger, and the first version is usually a `balance` column on the users table, updated by application code. It fails in predictable, silent ways:

| What happens | What goes wrong |
|---|---|
| Two requests spend from the same wallet at once | Both read the old balance. One update is lost, or the wallet goes negative. |
| A client times out and retries | The customer is credited twice. |
| Someone asks "why is this balance 40?" | There is no history to answer from, only the current number. |
| Amounts stored as floats | Rounding drift. Totals stop matching the bank. |
| Many customers' data in shared tables | One missing `WHERE tenant_id = ...` leaks another business's money. |

None of these show up in a demo. They show up months later, when finance cannot reconcile.

## What we promise

Each promise is an acceptance criterion, and each one has a test that would fail if the promise were broken (see the README's claims table).

1. **Money is never created or destroyed.** Every movement is a transfer from one account to another. Within a tenant, balances sum to zero per currency.
2. **No overdraft.** An account that is not allowed to go negative never does, even under concurrent requests.
3. **Retries are safe.** Repeating a request with the same `Idempotency-Key` returns the original transfer and never creates a second one.
4. **Tenants are isolated.** One tenant can never read or move another tenant's money. The database enforces this, not only the application code.
5. **Amounts are exact.** Integer minor units (cents, paisa) end to end, no floats, up to the 64-bit limit.
6. **History is append-only.** Transfers cannot be edited or deleted. A correction is a new transfer.

## Phase 1 scope: the core ledger API

- Tenants and API keys, created by an admin script. No self-serve signup yet.
- **Accounts:** a tenant-chosen `reference` (for example `wallet:cus_123`), a currency, and an `allow_negative` flag for funding accounts that represent money entering from outside.
- **Transfers:** from one account to another, an amount and a currency, idempotent.
- Read an account's balance and its transfer history.

How the product's concepts map onto Phase 1:

| Business action | Ledger operation |
|---|---|
| Top up a wallet / issue a credit | Transfer from the tenant's funding account (allow_negative) to the customer's wallet |
| Pay out to a customer | Transfer from the wallet to a payouts account (Phase 2 makes it two-step: pending, then posted or voided) |
| Refund | A new transfer in the opposite direction (Phase 2 links it to the original and caps it at the original amount) |

## Not doing (for now)

- Moving real money. Ledgerproof records who owns what; it does not talk to banks or card networks.
- Currency conversion. A transfer stays within one currency.
- Self-serve tenant signup and billing.
- Multi-leg transfers in a single call (for example a payout plus a fee). That is Phase 2, as an atomic batch.

## Roadmap

1. **Core ledger API** (this phase).
2. **Proof of performance** (done): a k6 load test measured the "hot account" problem (every top-up locked the same funding account) and the fix: top-up p95 went from ~400 ms to ~45 ms. See [docs/perf](docs/perf/README.md).
3. **AI assistant:** answers balance and history questions through read-only tools. Numbers come only from tool results, and evals check that it never invents an amount.
4. **Finance dashboard** (Next.js): balances, history, a reconciliation report.
5. **Payouts and refunds:** two-step transfers, linked refunds, a background worker, and webhooks via an outbox.
6. **Production:** CI, deployment to AWS, monitoring, and a nightly reconciliation job that alerts on any drift.

## How we know it works

- Zero invariant violations: balances always equal the sum of their transfers (tested now, checked nightly from Phase 6).
- A developer gets from API key to first transfer in under 10 minutes using the README quickstart.
- Latency targets are set after measuring (Phase 2), not guessed.
