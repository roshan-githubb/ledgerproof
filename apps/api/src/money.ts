import { badRequest } from './errors.js';

/** Largest value a Postgres bigint can hold. */
export const BIGINT_MAX = 9_223_372_036_854_775_807n;

/**
 * Amounts travel as decimal strings of minor units ("1500" = 15.00). A JSON number is an
 * IEEE-754 double and silently loses precision above 2^53, so numbers are rejected outright.
 */
export const AMOUNT_PATTERN = '^[1-9][0-9]{0,18}$';

export function parseAmount(raw: string): bigint {
  if (!new RegExp(AMOUNT_PATTERN).test(raw)) {
    throw badRequest('invalid_amount', 'amount must be a positive integer string of minor units');
  }
  const value = BigInt(raw);
  if (value > BIGINT_MAX) {
    throw badRequest('invalid_amount', `amount must be at most ${BIGINT_MAX}`);
  }
  return value;
}
