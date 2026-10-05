// 单位换算：十进制字符串（不含指数）乘以 分子/分母 的精确有理数，
// 按目标小数位做“中点取偶”舍入（round-half-even），输出定长小数字符串。
// 全程使用 BigInt 精确运算，支持 30 位有效数字与 12 位小数。

const DECIMAL_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
const INTEGER_PATTERN = /^\d+$/;

/** 将十进制字符串解析为 (符号, 整数 BigInt, 小数位数)；非法返回 null。 */
function parseDecimal(input: string): { negative: boolean; digits: bigint; fracLen: number } | null {
  if (!DECIMAL_PATTERN.test(input)) return null;
  let text = input;
  let negative = false;
  if (text.startsWith("+")) {
    text = text.slice(1);
  } else if (text.startsWith("-")) {
    negative = true;
    text = text.slice(1);
  }
  const dot = text.indexOf(".");
  const intPart = dot === -1 ? text : text.slice(0, dot);
  const fracPart = dot === -1 ? "" : text.slice(dot + 1);
  const allDigits = (intPart + fracPart).replace(/^0+(?=\d)/, "");
  return {
    negative,
    digits: BigInt(allDigits === "" ? "0" : allDigits),
    fracLen: fracPart.length,
  };
}

/**
 * 单位换算。非法输入（含指数、非十进制形式、非法倍率或精度）返回 null。
 * 输出保留 scale 位小数；负零输出为正零。
 */
export function convertUnit(
  input: string,
  numerator: string,
  denominator: string,
  scale: number,
): string | null {
  if (typeof input !== "string") return null;
  if (!Number.isInteger(scale) || scale < 0 || scale > 6) return null;
  if (!INTEGER_PATTERN.test(numerator)) return null;
  if (!INTEGER_PATTERN.test(denominator) || BigInt(denominator) === 0n) return null;

  const parsed = parseDecimal(input);
  if (parsed === null) return null;

  // 精确值 = digits * numerator * 10^scale / (10^fracLen * denominator)
  const num = parsed.digits * BigInt(numerator) * 10n ** BigInt(scale);
  const den = 10n ** BigInt(parsed.fracLen) * BigInt(denominator);

  // 对绝对值做中点取偶舍入，再补回符号。
  let quotient = num / den;
  const remainder = num % den;
  const twice = remainder * 2n;
  if (twice > den || (twice === den && quotient % 2n === 1n)) {
    quotient += 1n;
  }

  if (quotient === 0n) {
    // 负零归一为正零。
    return scale === 0 ? "0" : "0." + "0".repeat(scale);
  }

  let text = quotient.toString();
  if (scale > 0) {
    text = text.padStart(scale + 1, "0");
    text = text.slice(0, text.length - scale) + "." + text.slice(text.length - scale);
  }
  return (parsed.negative ? "-" : "") + text;
}
