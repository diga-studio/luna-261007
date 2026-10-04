/**
 * Exact rational numbers backed by BigInt.
 * Invariant: den > 0, gcd(|num|, den) = 1. Zero is 0/1.
 */
export interface Rational {
  readonly num: bigint;
  readonly den: bigint;
}

function gcdBigInt(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}

export function makeRational(num: bigint, den: bigint): Rational {
  if (den === 0n) {
    throw new Error("rational with zero denominator");
  }
  if (num === 0n) {
    return { num: 0n, den: 1n };
  }
  let n = num;
  let d = den;
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const g = gcdBigInt(n, d);
  return { num: n / g, den: d / g };
}

export function rationalFromBigInt(value: bigint): Rational {
  return { num: value, den: 1n };
}

/** Parse "3", "-7/2", "1.25", "-0.0000000001" into an exact Rational. */
export function parseRational(text: string): Rational {
  const trimmed = text.trim();
  const fraction = /^([+-]?\d+)\/(\d+)$/.exec(trimmed);
  if (fraction) {
    return makeRational(BigInt(fraction[1]), BigInt(fraction[2]));
  }
  const decimal = /^([+-]?)(\d*)(?:\.(\d+))?$/.exec(trimmed);
  if (decimal && (decimal[2] !== "" || decimal[3] !== undefined)) {
    const whole = decimal[2] === "" ? "0" : decimal[2];
    const frac = decimal[3] ?? "";
    const digits = whole + frac;
    const scale = 10n ** BigInt(frac.length);
    const value = BigInt(digits === "" ? "0" : digits);
    return makeRational(decimal[1] === "-" ? -value : value, scale);
  }
  throw new Error(`cannot parse rational: ${text}`);
}

export function add(a: Rational, b: Rational): Rational {
  return makeRational(a.num * b.den + b.num * a.den, a.den * b.den);
}

export function sub(a: Rational, b: Rational): Rational {
  return makeRational(a.num * b.den - b.num * a.den, a.den * b.den);
}

export function mul(a: Rational, b: Rational): Rational {
  return makeRational(a.num * b.num, a.den * b.den);
}

export function div(a: Rational, b: Rational): Rational {
  if (b.num === 0n) {
    throw new Error("division by zero rational");
  }
  return makeRational(a.num * b.den, a.den * b.num);
}

export function neg(a: Rational): Rational {
  return { num: -a.num, den: a.den };
}

/** -1, 0 or 1. */
export function sign(a: Rational): number {
  if (a.num === 0n) return 0;
  return a.num > 0n ? 1 : -1;
}

/** negative / zero / positive as a < b / a = b / a > b. */
export function cmp(a: Rational, b: Rational): number {
  const diff = a.num * b.den - b.num * a.den;
  if (diff === 0n) return 0;
  return diff > 0n ? 1 : -1;
}

export function isZero(a: Rational): boolean {
  return a.num === 0n;
}

export function toString(a: Rational): string {
  if (a.den === 1n) {
    return a.num.toString();
  }
  return `${a.num}/${a.den}`;
}
