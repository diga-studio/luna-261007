import type { Rational } from "./rational.js";
import * as R from "./rational.js";

/**
 * Dense univariate polynomial with exact rational coefficients.
 * coeffs[i] is the coefficient of x^i; no trailing zeros except that the
 * zero polynomial is the empty array.
 */
export interface Polynomial {
  readonly coeffs: readonly Rational[];
}

const ZERO: Polynomial = { coeffs: [] };

function normalize(coeffs: Rational[]): Polynomial {
  let end = coeffs.length;
  while (end > 0 && R.isZero(coeffs[end - 1])) {
    end--;
  }
  return { coeffs: coeffs.slice(0, end) };
}

export function fromBigIntCoeffs(coeffs: readonly bigint[]): Polynomial {
  return normalize(coeffs.map((c) => R.rationalFromBigInt(c)));
}

export function isZeroPoly(p: Polynomial): boolean {
  return p.coeffs.length === 0;
}

/** -1 for the zero polynomial. */
export function degree(p: Polynomial): number {
  return p.coeffs.length - 1;
}

export function evaluate(p: Polynomial, x: Rational): Rational {
  let acc = R.rationalFromBigInt(0n);
  for (let i = p.coeffs.length - 1; i >= 0; i--) {
    acc = R.add(R.mul(acc, x), p.coeffs[i]);
  }
  return acc;
}

export function add(p: Polynomial, q: Polynomial): Polynomial {
  const n = Math.max(p.coeffs.length, q.coeffs.length);
  const out: Rational[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = i < p.coeffs.length ? p.coeffs[i] : R.rationalFromBigInt(0n);
    const b = i < q.coeffs.length ? q.coeffs[i] : R.rationalFromBigInt(0n);
    out[i] = R.add(a, b);
  }
  return normalize(out);
}

export function sub(p: Polynomial, q: Polynomial): Polynomial {
  return add(p, scale(q, R.rationalFromBigInt(-1n)));
}

export function mul(p: Polynomial, q: Polynomial): Polynomial {
  if (isZeroPoly(p) || isZeroPoly(q)) {
    return ZERO;
  }
  const out: Rational[] = new Array(p.coeffs.length + q.coeffs.length - 1);
  for (let i = 0; i < out.length; i++) {
    out[i] = R.rationalFromBigInt(0n);
  }
  for (let i = 0; i < p.coeffs.length; i++) {
    for (let j = 0; j < q.coeffs.length; j++) {
      out[i + j] = R.add(out[i + j], R.mul(p.coeffs[i], q.coeffs[j]));
    }
  }
  return normalize(out);
}

export function scale(p: Polynomial, factor: Rational): Polynomial {
  if (R.isZero(factor)) {
    return ZERO;
  }
  return normalize(p.coeffs.map((c) => R.mul(c, factor)));
}

/** Exact quotient/remainder over the rationals. Requires q != 0. */
export function divmod(p: Polynomial, q: Polynomial): { quot: Polynomial; rem: Polynomial } {
  if (isZeroPoly(q)) {
    throw new Error("polynomial division by zero");
  }
  const rem: Rational[] = p.coeffs.slice();
  const quotLen = p.coeffs.length - q.coeffs.length + 1;
  if (quotLen <= 0) {
    return { quot: ZERO, rem: normalize(rem) };
  }
  const quot: Rational[] = new Array(quotLen);
  for (let i = 0; i < quotLen; i++) {
    quot[i] = R.rationalFromBigInt(0n);
  }
  const qLead = q.coeffs[q.coeffs.length - 1];
  const qDeg = q.coeffs.length - 1;
  for (let k = quotLen - 1; k >= 0; k--) {
    const coeff = R.div(rem[qDeg + k], qLead);
    quot[k] = coeff;
    for (let j = 0; j <= qDeg; j++) {
      rem[j + k] = R.sub(rem[j + k], R.mul(coeff, q.coeffs[j]));
    }
  }
  return { quot: normalize(quot), rem: normalize(rem.slice(0, qDeg)) };
}

export function derivative(p: Polynomial): Polynomial {
  if (p.coeffs.length <= 1) {
    return ZERO;
  }
  const out: Rational[] = new Array(p.coeffs.length - 1);
  for (let i = 1; i < p.coeffs.length; i++) {
    out[i - 1] = R.mul(p.coeffs[i], R.rationalFromBigInt(BigInt(i)));
  }
  return normalize(out);
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

/**
 * Rescale by a POSITIVE rational so coefficients become coprime integers.
 * Positive rescaling preserves signs of evaluations and Sturm counts.
 */
function primitivePositive(p: Polynomial): Polynomial {
  if (isZeroPoly(p)) {
    return p;
  }
  let lcm = 1n;
  for (const c of p.coeffs) {
    lcm = (lcm / gcdBigInt(lcm, c.den)) * c.den;
  }
  let content = 0n;
  const ints = p.coeffs.map((c) => {
    const v = c.num * (lcm / c.den);
    content = gcdBigInt(content, v);
    return v;
  });
  return fromBigIntCoeffs(ints.map((v) => v / content));
}

function monic(p: Polynomial): Polynomial {
  if (isZeroPoly(p)) {
    return p;
  }
  return scale(p, R.div(R.rationalFromBigInt(1n), p.coeffs[p.coeffs.length - 1]));
}

/** Monic greatest common divisor of p and q (zero polynomial if both are zero). */
export function gcd(p: Polynomial, q: Polynomial): Polynomial {
  let a = p;
  let b = q;
  while (!isZeroPoly(b)) {
    const r = primitivePositive(divmod(a, b).rem);
    a = b;
    b = r;
  }
  return monic(a);
}

export interface SquareFreeFactor {
  readonly factor: Polynomial;
  readonly multiplicity: number;
}

function isConstant(p: Polynomial): boolean {
  return p.coeffs.length <= 1;
}

/**
 * Yun's square-free factorization over Q: returns pairwise-coprime square-free
 * factors f_i with multiplicity i such that p = c * prod(f_i^i), c in Q.
 * Each returned factor is monic. Requires p != 0.
 */
export function squareFreeFactorization(p: Polynomial): SquareFreeFactor[] {
  if (isZeroPoly(p)) {
    throw new Error("square-free factorization of zero polynomial");
  }
  const result: SquareFreeFactor[] = [];
  const dp = derivative(p);
  let c = gcd(p, dp);
  let w = divmod(p, c).quot;
  let multiplicity = 1;
  while (!isConstant(w)) {
    const y = gcd(w, c);
    const z = divmod(w, y).quot;
    if (!isConstant(z)) {
      result.push({ factor: monic(z), multiplicity });
    }
    w = y;
    c = divmod(c, y).quot;
    multiplicity++;
  }
  if (!isConstant(c)) {
    // Over Q (characteristic 0) this is unreachable.
    throw new Error("unexpected p-th power part in square-free factorization");
  }
  return result;
}

/**
 * Sturm sequence of a square-free polynomial:
 * p0 = p, p1 = p', p_{i+1} = -rem(p_{i-1}, p_i), kept primitive over Z
 * (positive rescaling only, so sign variations are preserved).
 */
export function sturmSequence(p: Polynomial): Polynomial[] {
  if (isZeroPoly(p)) {
    throw new Error("Sturm sequence of zero polynomial");
  }
  const seq: Polynomial[] = [p];
  const dp = derivative(p);
  if (isZeroPoly(dp)) {
    return seq;
  }
  seq.push(dp);
  for (;;) {
    const r = divmod(seq[seq.length - 2], seq[seq.length - 1]).rem;
    if (isZeroPoly(r)) {
      return seq;
    }
    seq.push(primitivePositive(scale(r, R.rationalFromBigInt(-1n))));
  }
}

function signVariations(sturm: Polynomial[], x: Rational): number {
  const signs: number[] = [];
  for (const poly of sturm) {
    const s = R.sign(evaluate(poly, x));
    if (s !== 0) {
      signs.push(s);
    }
  }
  let variations = 0;
  for (let i = 1; i < signs.length; i++) {
    if (signs[i] !== signs[i - 1]) {
      variations++;
    }
  }
  return variations;
}

/**
 * Number of distinct real roots of square-free p in the OPEN interval (lo, hi).
 * Endpoints may themselves be roots; they are not counted.
 */
export function countRootsOpenInterval(
  sturm: Polynomial[],
  p: Polynomial,
  lo: Rational,
  hi: Rational,
): number {
  let count = signVariations(sturm, lo) - signVariations(sturm, hi);
  if (R.isZero(evaluate(p, hi))) {
    count -= 1;
  }
  return count;
}
