# ADR 0007: The assistant's numbers are inserted by the server, never written by the model

Status: accepted, 2026-11-26

## Context

The assistant answers questions about balances and transfers in plain language. Language models can invent, misremember or miscalculate numbers, and text stored in the ledger (transfer descriptions) can carry instructions meant to manipulate the model. In a payments product, a wrong amount stated confidently is worse than no answer.

"The model is usually right" isn't good enough. The requirement: every number a user sees was read from the database during that request.

## Decision

1. **Facts and placeholders.** Tools return every number, amount, date, time, reference and description as a fact, `{"fact": "f2", "value": "NPR 400.00"}`. The model sees the value but may mention it only as `{{f2}}`. The server substitutes the stored value.
2. **A digit check before anything is returned.** After removing placeholders, the answer must contain no decimal digit in any script (`\p{Nd}`: ASCII, Devanagari, Arabic-Indic, full-width...), and every placeholder must name a fact from this request. One rewrite is allowed; a second failure returns 502. An unchecked answer never leaves the server.
3. **Arithmetic in SQL.** Totals come from `summarize_transfers`, so the model never needs to add numbers.
4. **Access enforced below the model.** Tools run with the tenant from the API key under row-level security, in a `READ ONLY` transaction. In customer-facing mode, every tool is pinned to one account. The model never chooses the tenant and can't write.
5. **Our own loop on the Messages API**, not Managed Agents and not the SDK's beta tool runner (see Alternatives). The model sits behind a one-method interface, so tests drive it with a scripted fake.

## Alternatives

- **Check the answer's numbers against tool results afterwards** (allow a number if it appears in some tool output). Weaker: it lets through numbers that appear by coincidence and sums the model computed itself, and it is hard to prove complete. Placeholders make the guarantee structural.
- **Trust the system prompt** ("only state numbers from tools"). A prompt is a request, not a control. Injection tests show a model that "obeys" injected text gets caught only by the check.
- **Managed Agents** (Anthropic hosts the loop and a sandbox per session). Built for long-running agents with files and code. This is a seconds-long question inside our API. Managed Agents would add a beta dependency, session-runtime billing, and stored session history containing customers' balances. Chosen against, with the product owner, on 2026-11-26.
- **The SDK's tool runner** (beta). Saves about 40 lines of loop, but adds a beta dependency, and the loop is exactly where we inject the fake model for deterministic tests and enforce the turn limit and the rewrite rule. Owning it keeps every safety step visible in one function.

## Consequences and where it breaks

- **Answers can't contain numbers the tools don't produce.** "How much more do I need?" can only be answered in words ("your balance is lower than the order") until a tool computes differences. That's a deliberate trade.
- **Number words slip past the digit check.** "Four hundred" isn't a digit. The prompt forbids it and the check catches digits in every script, but spelled-out numbers are a known gap. A stricter answer format (structured output with fact ids only) would close it, at the cost of natural language.
- **Cost and latency.** Every question is one or more model calls (at most 6) plus tool queries. A rejected answer costs one extra turn. Usage is returned per request (`usage`) for monitoring.
- **The real model hasn't been run against this yet** (no API key on the development machine). The guarantees are tested with a fake model; how often the real model needs a rewrite is unmeasured. Next step: a small live evaluation, approved by the product owner (questions, grading, budget).
- **Refusals** are retried server-side on a fallback model (`fallbacks: "default"`); a refusal from the whole chain returns 502.

## Proof

`test/assistant.test.ts` and `test/assistant-units.test.ts`:
- exact balances via placeholders
- invented numbers rejected after one rewrite, and a corrected rewrite accepted
- unknown placeholders and Devanagari, Arabic-Indic and full-width digits rejected
- injected instructions in transfer descriptions can't produce a number
- SQL totals
- another tenant's data never reaches the model
- one-account scope enforced
- read-only enforced by Postgres
- 6-turn limit
- bad tool input handled
- refusals mapped to 502
- request shape (strict tools, no forced tool choice)
- exact money formatting above 2^53

The mutation check removes the digit check, read-only and the scope check, and each matching test fails.
