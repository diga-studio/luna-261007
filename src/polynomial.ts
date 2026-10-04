import { Rational } from "./rational";

/** Polynomial with rational coefficients, ascending order: p[i] is the coefficient of x^i.
 *  Invariant: no trailing zero coefficients (the zero polynomial is []). */
export type Poly = Rational[];

function trim(p: Poly): Poly {
  let n = p.length;
  while (n > 0 && p[n - 1]!.isZero()) n--;
  return p.slice(0, n);
}

export function constPoly(c: Rational): Poly {
  return c.isZero() ? [] : [c];
}

export function isZeroPoly(p: Poly): boolean {
  return p.length === 0;
}

export function isOnePoly(p: Poly): boolean {
  return p.length === 1 && p[0]!.num === 1n && p[0]!.den === 1n;
}

/** Degree of the polynomial; -1 for the zero polynomial. */
export function degree(p: Poly): number {
  return p.length - 1;
}

export function addPoly(a: Poly, b: Poly): Poly {
  const n = Math.max(a.length, b.length);
  const out: Rational[] = [];
  for (let i = 0; i < n; i++) {
    const x = i < a.length ? a[i]! : Rational.zero();
    const y = i < b.length ? b[i]! : Rational.zero();
    out.push(x.add(y));
  }
  return trim(out);
}

export function subPoly(a: Poly, b: Poly): Poly {
  return addPoly(a, scalePoly(b, Rational.of(-1n)));
}

export function mulPoly(a: Poly, b: Poly): Poly {
  if (a.length === 0 || b.length === 0) return [];
  const out: Rational[] = new Array(a.length + b.length - 1).fill(Rational.zero());
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      out[i + j] = out[i + j]!.add(a[i]!.mul(b[j]!));
    }
  }
  return trim(out);
}

export function scalePoly(a: Poly, s: Rational): Poly {
  if (s.isZero() || a.length === 0) return [];
  return trim(a.map((c) => c.mul(s)));
}

/** Returns [quotient, remainder] of a / b; b must be non-zero. */
export function divmodPoly(a: Poly, b: Poly): [Poly, Poly] {
  if (b.length === 0) throw new Error("divmodPoly: division by zero polynomial");
  let rem = a.slice();
  const quot: Rational[] = new Array(Math.max(0, a.length - b.length + 1)).fill(Rational.zero());
  const bLead = b[b.length - 1]!;
  while (rem.length >= b.length && rem.length > 0) {
    const shift = rem.length - b.length;
    const factor = rem[rem.length - 1]!.div(bLead);
    quot[shift] = factor;
    const sub: Rational[] = new Array(shift).fill(Rational.zero());
    for (let j = 0; j < b.length; j++) sub.push(b[j]!.mul(factor));
    rem = trim(subPoly(rem, sub));
  }
  return [trim(quot), rem];
}

/** Exact division; throws if the division is not exact. */
export function divExactPoly(a: Poly, b: Poly): Poly {
  const [q, r] = divmodPoly(a, b);
  if (r.length !== 0) throw new Error("divExactPoly: division is not exact");
  return q;
}

export function derivativePoly(p: Poly): Poly {
  const out: Rational[] = [];
  for (let i = 1; i < p.length; i++) out.push(p[i]!.mul(Rational.of(BigInt(i))));
  return trim(out);
}

export function evaluatePoly(p: Poly, x: Rational): Rational {
  let acc = Rational.zero();
  for (let i = p.length - 1; i >= 0; i--) acc = acc.mul(x).add(p[i]!);
  return acc;
}

function makeMonic(p: Poly): Poly {
  if (p.length === 0) return p;
  return scalePoly(p, Rational.one().div(p[p.length - 1]!));
}

/** Monic greatest common divisor of two polynomials (gcd with zero is the other one, monic). */
export function gcdPoly(a: Poly, b: Poly): Poly {
  let x = a;
  let y = b;
  while (y.length !== 0) {
    const [, r] = divmodPoly(x, y);
    x = y;
    y = r;
  }
  return makeMonic(x);
}

/**
 * Yun's square-free factorization over the rationals (characteristic 0).
 * Returns factors where factors[i] is Q_{i+1}: each root of factors[i] has
 * multiplicity exactly i+1 in p. Degree-0 entries may appear for
 * multiplicities that do not occur. p must be non-zero.
 */
export function squareFreeFactors(p: Poly): Poly[] {
  if (p.length === 0) throw new Error("squareFreeFactors: zero polynomial");
  const df = derivativePoly(p);
  let carry = gcdPoly(p, df);
  let w = divExactPoly(p, carry);
  const factors: Poly[] = [];
  while (!isOnePoly(w)) {
    const y = gcdPoly(w, carry);
    const z = divExactPoly(w, y);
    factors.push(z);
    w = y;
    carry = divExactPoly(carry, y);
  }
  return factors;
}
