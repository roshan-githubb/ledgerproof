# Ledgerproof

A multi-tenant payments ledger API, with an AI assistant planned. Product scope lives in PRODUCT.md and design decisions live in docs/decisions/.

## How AI agents work in this repo

Most code here is drafted with Claude Code. A human owns every line that ships. These rules keep agent output honest:

- **Plan before code.** Non-trivial work starts as a short plan in docs/plans/, reviewed before implementation.
- **Record decisions.** Every non-obvious choice gets a short record in docs/decisions/: what was chosen, what was rejected, and where it breaks (under load, on a retry, on a crash halfway, with two users at once).
- **Settle doubts with evidence.** When the agent is unsure, or a library default or an agent suggestion might be confidently wrong, settle it with a test or a measurement, not an opinion.
- **Prove tests can fail.** A correctness test must fail when its guarantee is removed. `scripts/mutation-check.ts` checks this.
- **Log the agent's mistakes.** After each feature, record what was verified and where the agent was wrong in docs/ai-workflow-log.md.

## Repo rules

- Money is stored as integer minor units (bigint) and sent as decimal strings. Never floats.
- Every correctness claim (concurrency, retries, idempotency, tenant isolation, data integrity) gets a test that would fail if the claim were false. Integration tests use real Postgres.
- No performance claims without before/after numbers and the command to reproduce them.

## Stack

TypeScript pnpm monorepo: Fastify API, Next.js web, a background worker, Postgres, Vitest + Testcontainers, Playwright, k6. Deployed to AWS later.
