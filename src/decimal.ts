/**
 * Fixed-point decimal arithmetic with 8 fractional digits, backed by BigInt.
 * All token amounts and rates are integers scaled by 10^8 ("units").
 * Exact products of two such values are scaled by 10^16 ("product units").
 */

export const SCALE = 100_000_000n; // 10^8
export const PRODUCT_SCALE = SCALE * SCALE; // 10^16

const MIN_FEE_UNITS = 10_000n; // 0.00010000

const DECIMAL_RE = /^(0|[1-9]\d*)(\.\d{1,8})?$/;

/** True when the string is a valid non-negative decimal with <= 8 fractional digits. */
export function isValidDecimal(value: string): boolean {
  return DECIMAL_RE.test(value);
}

/** Parse an 8-decimal string into scaled units. Throws on invalid input. */
export function parseUnits(value: string): bigint {
  if (!DECIMAL_RE.test(value)) {
    throw new Error(`invalid decimal: ${JSON.stringify(value)}`);
  }
  const dot = value.indexOf('.');
  if (dot === -1) {
    return BigInt(value) * SCALE;
  }
  const intPart = value.slice(0, dot);
  const fracPart = value.slice(dot + 1).padEnd(8, '0');
  return BigInt(intPart) * SCALE + BigInt(fracPart);
}

/** Format scaled units as a canonical 8-decimal string. */
export function formatUnits(units: bigint): string {
  if (units < 0n) {
    throw new Error('cannot format negative units');
  }
  const intPart = units / SCALE;
  const fracPart = (units % SCALE).toString().padStart(8, '0');
  return `${intPart}.${fracPart}`;
}

/** Format exact product units (scale 10^16) as a decimal string, trailing zeros trimmed. */
export function formatProduct(productUnits: bigint): string {
  if (productUnits < 0n) {
    throw new Error('cannot format negative product units');
  }
  const intPart = productUnits / PRODUCT_SCALE;
  let fracPart = (productUnits % PRODUCT_SCALE).toString().padStart(16, '0');
  fracPart = fracPart.replace(/0+$/, '');
  return fracPart === '' ? intPart.toString() : `${intPart}.${fracPart}`;
}

/** fee = max(ceil(principal * 0.001), 0.00010000), all in scaled units. */
export function feeOf(principalUnits: bigint): bigint {
  const pct = (principalUnits + 999n) / 1000n; // ceil(p / 1000) == ceil(p * 0.001)
  return pct > MIN_FEE_UNITS ? pct : MIN_FEE_UNITS;
}

/** Exact product principal * rate, in product units (scale 10^16). */
export function exactProduct(amountUnits: bigint, rateUnits: bigint): bigint {
  return amountUnits * rateUnits;
}
