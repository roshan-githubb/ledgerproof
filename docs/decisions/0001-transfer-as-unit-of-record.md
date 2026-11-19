# ADR 0001: The transfer is the unit of record

Status: accepted, 2026-11-19

## Context

A ledger must never create or destroy money. The classic design is double-entry bookkeeping: a journal of entries where each transaction's debits and credits sum to zero.

## Decision

Store one row per **transfer**: `from_account_id`, `to_account_id`, `amount > 0`. There is no separate entries table. `accounts.balance` is a cached total, updated in the same database transaction as the transfer insert. (Since [ADR 0006](0006-uncached-funding-balances.md), only balance-checked accounts cache it; funding accounts compute it from history.)

This is still double-entry, just encoded differently. Each transfer row is one debit and one credit of the same amount. The difference is that zero-sum holds **by construction**: there is no way to write an unbalanced transfer, so nothing needs to check it. (TigerBeetle uses the same model.)

## Alternatives rejected

- **Journal entries table** (one row per leg, signed amounts). More general: a single journal transaction can have any number of legs. But "the legs sum to zero" then has to be enforced by a deferred constraint trigger or by application code, which is one more invariant that can break. We don't need multi-leg yet.
- **No cached balance** (always compute from history). Simpler, with nothing to drift. But reading a balance becomes O(history), and there is no row to lock for the overdraft check (ADR 0002).

## Consequences and where it breaks

- **Multi-leg movements** (a payout plus a fee) become several transfers in one database transaction: a "batch". Planned for Phase 2. If we ever need true N-leg entries, we would add a journal table and keep transfers as a view.
- **Cached balance can drift** if some code path updates one without the other. Mitigations: the app role may only update the `balance` column; `findViolations()` recomputes every balance from history; the nightly reconciliation job (Phase 6) runs it and alerts.
- **History query**: an account's history is `from = X OR to = X`, which reads two indexes. Fine now; measure in Phase 2 before changing it.

## Proof

- `test/invariants.test.ts`: after 200 random concurrent transfers, every balance equals sum(in) - sum(out), and the tenant nets to zero.
- The same file shows the checker reports drift when a balance is corrupted on purpose, so the invariant test can actually fail.
