function absBig(v: bigint): bigint {
  return v < 0n ? -v : v;
}

function gcdBig(a: bigint, b: bigint): bigint {
  let x = absBig(a);
  let y = absBig(b);
  while (y !== 0n) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x === 0n ? 1n : x;
}

/**
 * Exact rational number. Always normalized: den > 0 and gcd(|num|, den) = 1,
 * so two Rationals are equal iff num and den match.
 */
export class Rational {
  private constructor(
    public readonly num: bigint,
    public readonly den: bigint,
  ) {}

  static of(num: bigint | number | string, den: bigint | number | string = 1n): Rational {
    let n = BigInt(num);
    let d = BigInt(den);
    if (d === 0n) throw new Error("Rational: denominator must be non-zero");
    if (d < 0n) {
      n = -n;
      d = -d;
    }
    if (n === 0n) return new Rational(0n, 1n);
    const g = gcdBig(n, d);
    return new Rational(n / g, d / g);
  }

  static zero(): Rational {
    return new Rational(0n, 1n);
  }

  static one(): Rational {
    return new Rational(1n, 1n);
  }

  isZero(): boolean {
    return this.num === 0n;
  }

  sign(): -1 | 0 | 1 {
    return this.num > 0n ? 1 : this.num < 0n ? -1 : 0;
  }

  add(o: Rational): Rational {
    return Rational.of(this.num * o.den + o.num * this.den, this.den * o.den);
  }

  sub(o: Rational): Rational {
    return Rational.of(this.num * o.den - o.num * this.den, this.den * o.den);
  }

  mul(o: Rational): Rational {
    return Rational.of(this.num * o.num, this.den * o.den);
  }

  div(o: Rational): Rational {
    if (o.isZero()) throw new Error("Rational: division by zero");
    return Rational.of(this.num * o.den, this.den * o.num);
  }

  neg(): Rational {
    return Rational.of(-this.num, this.den);
  }

  compare(o: Rational): -1 | 0 | 1 {
    const d = this.num * o.den - o.num * this.den;
    return d > 0n ? 1 : d < 0n ? -1 : 0;
  }

  equals(o: Rational): boolean {
    return this.num === o.num && this.den === o.den;
  }

  toString(): string {
    return this.den === 1n ? this.num.toString() : `${this.num}/${this.den}`;
  }
}
