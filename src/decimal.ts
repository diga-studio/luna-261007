/**
 * Decimal values arrive as strings with exactly two fraction digits
 * (e.g. "3.75", "4.00"). They are parsed into integer hundredths so all
 * GPA math stays exact (BigInt), never touching binary floating point.
 */

/** A non-negative decimal with exactly two fraction digits, stored as integer hundredths. */
export type Hundredths = bigint;

/** Parse a two-decimal string like "3.75" into integer hundredths. Throws on invalid input. */
export function parseHundredths(raw: string, field: string): Hundredths {
  if (typeof raw !== 'string' || !/^\d+\.\d{2}$/.test(raw)) {
    throw new Error(`${field} must be a decimal string with exactly two fraction digits, got ${JSON.stringify(raw)}`);
  }
  const dot = raw.indexOf('.');
  return BigInt(raw.slice(0, dot)) * 100n + BigInt(raw.slice(dot + 1));
}

/**
 * Round the exact rational value `numerator / denominator` to two decimals
 * using half-up, and format it as a string like "3.75".
 * numerator/denominator must be a non-negative rational with denominator > 0.
 */
export function formatHalfUp(numerator: bigint, denominator: bigint): string {
  if (denominator <= 0n) {
    throw new Error('denominator must be positive');
  }
  const scaled = numerator * 100n;
  let quotient = scaled / denominator;
  const remainder = scaled % denominator;
  if (remainder * 2n >= denominator) {
    quotient += 1n;
  }
  const whole = quotient / 100n;
  const fraction = quotient % 100n;
  return `${whole}.${fraction.toString().padStart(2, '0')}`;
}
