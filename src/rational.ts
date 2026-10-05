export interface Rat {
  n: bigint;
  d: bigint;
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}

export function rat(n: bigint, d: bigint): Rat {
  if (d === 0n) throw new Error('zero denominator');
  let nn = n;
  let dd = d;
  if (dd < 0n) {
    nn = -nn;
    dd = -dd;
  }
  const g = gcd(nn, dd);
  if (g > 1n) {
    nn /= g;
    dd /= g;
  }
  return { n: nn, d: dd };
}

export function ratFromInt(n: bigint): Rat {
  return { n, d: 1n };
}

export function ratFromDecimalString(s: string): Rat {
  return rat(BigInt(s), 1n);
}

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

export function div(a: Rat, b: Rat): Rat {
  return rat(a.n * b.d, a.d * b.n);
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

export function floorDiv(n: bigint, d: bigint): bigint {
  const q = n / d;
  return n % d !== 0n && (n < 0n) !== (d < 0n) ? q - 1n : q;
}

export function ceilDiv(n: bigint, d: bigint): bigint {
  const q = n / d;
  return n % d !== 0n && (n < 0n) === (d < 0n) ? q + 1n : q;
}

export function floorRat(a: Rat): bigint {
  return floorDiv(a.n, a.d);
}

export function ceilRat(a: Rat): bigint {
  return ceilDiv(a.n, a.d);
}

export function isZero(a: Rat): boolean {
  return a.n === 0n;
}
