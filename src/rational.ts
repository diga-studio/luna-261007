/** Exact rational number with BigInt numerator/denominator, kept reduced, d > 0. */
export interface Rat {
  n: bigint;
  d: bigint;
}

export function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}

export function rat(n: bigint, d: bigint = 1n): Rat {
  if (d === 0n) throw new Error('rational with zero denominator');
  if (n === 0n) return { n: 0n, d: 1n };
  let nn = n;
  let dd = d;
  if (dd < 0n) {
    nn = -nn;
    dd = -dd;
  }
  const g = gcd(nn, dd);
  return { n: nn / g, d: dd / g };
}

export const ZERO: Rat = { n: 0n, d: 1n };

export function add(a: Rat, b: Rat): Rat {
  return rat(a.n * b.d + b.n * a.d, a.d * b.d);
}

export function sub(a: Rat, b: Rat): Rat {
  return rat(a.n * b.d - b.n * a.d, a.d * b.d);
}

export function mul(a: Rat, b: Rat): Rat {
  return rat(a.n * b.n, a.d * b.d);
}

export function mulInt(a: Rat, k: bigint): Rat {
  return rat(a.n * k, a.d);
}

export function cmp(a: Rat, b: Rat): number {
  const lhs = a.n * b.d;
  const rhs = b.n * a.d;
  return lhs < rhs ? -1 : lhs > rhs ? 1 : 0;
}

export function min(a: Rat, b: Rat): Rat {
  return cmp(a, b) <= 0 ? a : b;
}

export function max(a: Rat, b: Rat): Rat {
  return cmp(a, b) >= 0 ? a : b;
}

/** Smallest integer >= a. */
export function ceil(a: Rat): bigint {
  const q = a.n / a.d;
  return a.n % a.d === 0n ? q : a.n > 0n ? q + 1n : q;
}

/** Largest integer <= a. */
export function floor(a: Rat): bigint {
  const q = a.n / a.d;
  return a.n % a.d === 0n ? q : a.n < 0n ? q - 1n : q;
}
