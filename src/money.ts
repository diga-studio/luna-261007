/** 非负有理数，BigInt 精确表示，den > 0。 */
export interface Rational {
  num: bigint;
  den: bigint;
}

export function rational(num: bigint, den: bigint): Rational {
  if (den <= 0n) {
    throw new Error("denominator must be positive");
  }
  if (num < 0n) {
    throw new Error("only non-negative amounts are supported");
  }
  return { num, den };
}

/** 向下取整。 */
export function floorRational(value: Rational): bigint {
  return value.num / value.den;
}

/** 半分向上舍入到整数分（值均非负）：floor(x + 1/2)。 */
export function roundHalfUp(value: Rational): bigint {
  return (2n * value.num + value.den) / (2n * value.den);
}

/**
 * 把已舍入的总额按最大余数法分摊到各行，使各行之和等于 roundedTotal，
 * 且每行与其未舍入值之差小于 1 分。
 * 余数并列时按 tieBreakKeys 字典序升序优先，保证结果与输入顺序、记录拆分无关。
 */
export function allocateRounded(
  unrounded: Rational[],
  roundedTotal: bigint,
  tieBreakKeys: string[],
): bigint[] {
  const floors = unrounded.map((value) => floorRational(value));
  let remaining = roundedTotal - floors.reduce((acc, v) => acc + v, 0n);

  const order = unrounded.map((_, index) => index);
  order.sort((a, b) => {
    const ra = unrounded[a]!.num % unrounded[a]!.den;
    const rb = unrounded[b]!.num % unrounded[b]!.den;
    const left = ra * unrounded[b]!.den;
    const right = rb * unrounded[a]!.den;
    if (left !== right) {
      return left > right ? -1 : 1;
    }
    const ka = tieBreakKeys[a]!;
    const kb = tieBreakKeys[b]!;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  const result = [...floors];
  for (const index of order) {
    if (remaining <= 0n) {
      break;
    }
    result[index] = result[index]! + 1n;
    remaining -= 1n;
  }
  return result;
}
