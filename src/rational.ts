import type { Rational } from "./types.js";

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x === 0n ? 1n : x;
}

/** 由分子分母构造约分后的有理数。 */
export function makeRational(numerator: bigint, denominator: bigint): Rational {
  if (denominator === 0n) {
    throw new Error("denominator must not be zero");
  }
  let num = numerator;
  let den = denominator;
  if (den < 0n) {
    num = -num;
    den = -den;
  }
  const divisor = gcd(num, den);
  return { numerator: num / divisor, denominator: den / divisor };
}

/** 精确求和。 */
export function addRationals(a: Rational, b: Rational): Rational {
  return makeRational(
    a.numerator * b.denominator + b.numerator * a.denominator,
    a.denominator * b.denominator,
  );
}

/**
 * 比较两个有理数。
 * 返回负数表示 a < b，0 表示相等，正数表示 a > b。
 */
export function compareRationals(a: Rational, b: Rational): number {
  const left = a.numerator * b.denominator;
  const right = b.numerator * a.denominator;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** 格式化为 "分子/分母" 形式，便于报告。 */
export function formatRational(value: Rational): string {
  return `${value.numerator}/${value.denominator}`;
}
