/**
 * Fixed-point decimal helpers. Amounts and rates carry 8 fractional digits
 * and are stored as BigInt "units" of 1e-8. Valuations (amount * rate) are
 * kept exactly as BigInt of 1e-16 USDT.
 */

export const SCALE = 100_000_000n; // 1e8
export const VALUATION_SCALE = 10_000_000_000_000_000n; // 1e16

const UNITS_RE = /^(\d+)(?:\.(\d{1,8}))?$/;

/** Parse an 8-decimal string into 1e-8 units. Returns null when invalid. */
export function parseUnits(value: string): bigint | null {
  const match = UNITS_RE.exec(value);
  if (match === null) return null;
  const intPart = match[1] as string;
  const fracPart = (match[2] ?? '').padEnd(8, '0');
  return BigInt(intPart) * SCALE + BigInt(fracPart === '' ? '0' : fracPart);
}

/** Format 1e-8 units as an 8-decimal string. */
export function formatUnits(units: bigint): string {
  const intPart = units / SCALE;
  const fracPart = (units % SCALE).toString().padStart(8, '0');
  return `${intPart}.${fracPart}`;
}

/** Format an exact 1e-16 valuation as a decimal string (16 fractional digits). */
export function formatValuation(valuation: bigint): string {
  const intPart = valuation / VALUATION_SCALE;
  const fracPart = (valuation % VALUATION_SCALE).toString().padStart(16, '0');
  return `${intPart}.${fracPart}`;
}
