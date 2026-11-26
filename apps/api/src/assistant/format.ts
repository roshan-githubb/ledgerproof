const fractionDigitsCache = new Map<string, number>();

/** Minor-unit digits for a currency: 2 for USD and NPR, 0 for JPY, 3 for KWD. */
export function fractionDigits(currency: string): number {
  let digits = fractionDigitsCache.get(currency);
  if (digits === undefined) {
    try {
      digits =
        new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
          .maximumFractionDigits ?? 2;
    } catch {
      digits = 2;
    }
    fractionDigitsCache.set(currency, digits);
  }
  return digits;
}

/**
 * Formats a bigint minor-unit amount ("150050" NPR) as "NPR 1,500.50". Works on the decimal
 * string and never converts to a JS number, so amounts above 2^53 stay exact.
 */
export function formatAmount(minor: string, currency: string): string {
  const negative = minor.startsWith('-');
  const digits = (negative ? minor.slice(1) : minor).replace(/^0+(?=\d)/, '');
  const scale = fractionDigits(currency);
  const padded = digits.padStart(scale + 1, '0');
  const whole = padded.slice(0, padded.length - scale);
  const fraction = scale > 0 ? `.${padded.slice(padded.length - scale)}` : '';
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${currency} ${grouped}${fraction}`;
}

/** "2026-11-26 10:15 UTC": unambiguous, timezone stated. */
export function formatTimestamp(date: Date): string {
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}
