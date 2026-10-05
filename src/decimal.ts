/** 十进制字符串的精确解析、乘除与定点舍入（单位换算用）。 */

export interface DecimalValue {
  /** 有效数字（无小数点、无符号；可能含前导零，零为 "0"）。 */
  readonly digits: string;
  /** 小数位数（digits 末尾起算）。 */
  readonly scale: number;
  readonly negative: boolean;
}

const DECIMAL_RE = /^[+-]?(\d+)(\.\d+)?$/;
const INTEGER_RE = /^[+-]?\d+$/;

function stripLeadingZeros(digits: string): string {
  const stripped = digits.replace(/^0+/, "");
  return stripped === "" ? "0" : stripped;
}

/** 解析不含指数的十进制字符串；非法返回 null。 */
export function parseDecimal(input: unknown): DecimalValue | null {
  if (typeof input !== "string") return null;
  const match = DECIMAL_RE.exec(input);
  if (match === null) return null;
  const negative = input.startsWith("-");
  const intPart = match[1] as string;
  const fracPart = match[2] === undefined ? "" : match[2].slice(1);
  const digits = stripLeadingZeros(intPart + fracPart);
  const isZero = digits === "0";
  return {
    digits,
    scale: isZero ? 0 : fracPart.length,
    negative: negative && !isZero,
  };
}

/** 解析整数（可带符号、可前导零）字符串；非法返回 null。 */
export function parseInteger(input: unknown): DecimalValue | null {
  if (typeof input !== "string") return null;
  if (!INTEGER_RE.test(input)) return null;
  const negative = input.startsWith("-");
  const digits = stripLeadingZeros(input.replace(/^[+-]/, ""));
  const isZero = digits === "0";
  return { digits, scale: 0, negative: negative && !isZero };
}

function pow10(n: number): bigint {
  return 10n ** BigInt(n);
}

/**
 * value * numerator / denominator，按 scale 位小数做银行家舍入
 * （恰好中点时取末位偶数），输出固定 scale 位小数的字符串；负零输出正零。
 */
export function mulDivRound(
  value: DecimalValue,
  numerator: DecimalValue,
  denominator: DecimalValue,
  scale: number,
): string {
  const num = BigInt(value.digits) * BigInt(numerator.digits) * pow10(scale);
  const den = BigInt(denominator.digits) * pow10(value.scale);
  let quotient = num / den;
  const remainder = num % den;
  const twice = remainder * 2n;
  if (twice > den || (twice === den && quotient % 2n === 1n)) {
    quotient += 1n;
  }
  const negative = (value.negative !== numerator.negative) && quotient !== 0n;
  let text = quotient.toString();
  if (scale > 0) {
    text = text.padStart(scale + 1, "0");
    text = `${text.slice(0, text.length - scale)}.${text.slice(text.length - scale)}`;
  }
  return negative ? `-${text}` : text;
}
