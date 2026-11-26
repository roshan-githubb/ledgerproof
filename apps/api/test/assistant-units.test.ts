import { describe, expect, it } from 'vitest';
import { FactSheet } from '../src/assistant/facts.js';
import { formatAmount } from '../src/assistant/format.js';

describe('formatAmount (exact, never via a JS number)', () => {
  it.each([
    ['9007199254740993', 'USD', 'USD 90,071,992,547,409.93'], // 2^53 + 1: not representable as a double
    ['40000', 'NPR', 'NPR 400.00'],
    ['5', 'USD', 'USD 0.05'],
    ['0', 'NPR', 'NPR 0.00'],
    ['-150050', 'NPR', '-NPR 1,500.50'],
    ['1500', 'JPY', 'JPY 1,500'], // no minor unit
    ['1500', 'KWD', 'KWD 1.500'], // three decimals
  ])('%s %s -> %s', (minor, currency, expected) => {
    expect(formatAmount(minor, currency)).toBe(expected);
  });
});

describe('FactSheet', () => {
  function sheetWithBalance() {
    const facts = new FactSheet();
    const ref = facts.add('balance of wallet:sita', 'NPR 400.00');
    return { facts, ref };
  }

  it('accepts placeholders for real facts and renders their exact values', () => {
    const { facts, ref } = sheetWithBalance();
    const answer = `Your balance is {{${ref.fact}}}.`;
    expect(facts.check(answer)).toEqual({ ok: true });
    expect(facts.render(answer)).toBe('Your balance is NPR 400.00.');
    expect(facts.cited(answer)).toEqual([{ id: ref.fact, label: 'balance of wallet:sita', value: 'NPR 400.00' }]);
  });

  it.each([
    ['ASCII digits', 'Your balance is 400.'],
    ['Devanagari digits', 'शेष रकम ४००'],
    ['Arabic-Indic digits', 'الرصيد ٤٠٠'],
    ['full-width digits', 'Balance ４００'],
    ['a digit next to a placeholder', 'Balance {{f1}}0'],
  ])('rejects %s', (_label, answer) => {
    const { facts } = sheetWithBalance();
    expect(facts.check(answer).ok).toBe(false);
  });

  it('rejects unknown placeholders and empty answers', () => {
    const { facts } = sheetWithBalance();
    expect(facts.check('Balance {{f2}}')).toEqual({
      ok: false,
      problems: ['these placeholders match no tool result: f2'],
    });
    expect(facts.check('   ').ok).toBe(false);
  });
});
