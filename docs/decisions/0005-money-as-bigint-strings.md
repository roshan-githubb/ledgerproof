# ADR 0005: Money is bigint minor units, sent as strings, validated strictly

Status: accepted, 2026-11-19

## Context

Floats can't represent most decimal amounts exactly (0.1 + 0.2 ≠ 0.3). JSON numbers are IEEE-754 doubles in JavaScript, so any integer above 2^53 (9,007,199,254,740,992) silently loses precision when parsed.

## Decision

- Store amounts and balances as Postgres `bigint` **minor units** (cents, paisa). `1500` USD means $15.00.
- On the wire, amounts are **decimal strings**: `"amount": "1500"`. node-postgres already returns `bigint` as a string, so amounts never pass through a JS number anywhere.
- Validate with `^[1-9][0-9]{0,18}$`, plus a BigInt comparison against 9,223,372,036,854,775,807.
- Fastify's validator is configured with `coerceTypes: false` and `removeAdditional: false`. Its defaults would turn the JSON number `9007199254740993` into the string `"9007199254740992"` (one unit lost, silently) and drop misspelled fields like `ammount` instead of rejecting them.
- A balance pushed past the 64-bit limit returns 422 `balance_out_of_range` (Postgres error 22003), not a 500.

## Alternatives rejected

- **`numeric(19,4)` / decimal amounts.** Allows fractions of a minor unit, which a ledger shouldn't have. Arithmetic is slower, and every client still has to agree on the precision.
- **JSON numbers.** Fine below 2^53, silently wrong above it. Strings make the failure impossible instead of unlikely.

## Consequences and where it breaks

- Clients must format amounts themselves using each currency's exponent (2 for USD, 0 for JPY, 3 for KWD). We don't store exponents yet.
- 18-decimal crypto tokens don't fit in bigint minor units. They would need `numeric`, which is out of scope.

## Proof

`test/api.test.ts`:
- 9007199254740993 (2^53 + 1) round-trips exactly
- the same value as a JSON number gets 400 (the mutation check turns coercion back on and this test fails)
- decimals, zero, negatives, leading zeros, text and values over the 64-bit limit get 400
- overflowing a balance gets 422
