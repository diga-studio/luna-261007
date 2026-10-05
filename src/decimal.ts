/**
 * Decimal helpers. Points and credits are decimal strings with exactly two
 * fractional digits; they are parsed into integers scaled by 100 so all GPA
 * math stays exact with BigInt rationals.
 */

const TWO_DECIMAL_PATTERN = /^\d+\.\d{2}$/;

/** Parse a two-decimal string (e.g. "3.75") into an integer scaled by 100. */
export function parseScaled(value: string): bigint {
  if (!TWO_DECIMAL_PATTERN.test(value)) {
    throw new Error(`invalid decimal string: ${JSON.stringify(value)}`);
  }
  const dotIndex = value.indexOf(".");
  const whole = value.slice(0, dotIndex);
  const fraction = value.slice(dotIndex + 1);
  return BigInt(whole) * 100n + BigInt(fraction);
}

/** Format the rational numerator/denominator as a GPA string with two
 *  decimals, rounding half-up. */
export function formatGpa(numerator: bigint, denominator: bigint): string {
  if (denominator <= 0n) {
    throw new Error("denominator must be positive");
  }
  // scaled = round(numerator * 100 / denominator), half-up.
  const scaled = (numerator * 200n + denominator) / (denominator * 2n);
  const whole = scaled / 100n;
  const fraction = scaled % 100n;
  return `${whole}.${fraction.toString().padStart(2, "0")}`;
}
