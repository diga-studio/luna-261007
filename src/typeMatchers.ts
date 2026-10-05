/**
 * 列类型匹配器。所有匹配器均假定输入为 CSV 解码后的原文（不裁剪）。
 * 调用方须先用 hasEdgeWhitespace 排除首尾含 White_Space 的非空值，
 * 此类值只能匹配 text。
 */

const EDGE_WHITESPACE = /^\p{White_Space}|\p{White_Space}$/u;

/** 非空值首尾含 Unicode White_Space 时只能匹配 text。 */
export function hasEdgeWhitespace(value: string): boolean {
  return EDGE_WHITESPACE.test(value);
}

const BOOLEAN_RE = /^(?:true|false)$/i;

export function matchBoolean(value: string): boolean {
  return BOOLEAN_RE.test(value);
}

const INTEGER_RE = /^[+-]?\d+$/;

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);

/** 十进制整数字面量（可带正负号）是否落在 JavaScript 安全整数范围。 */
function isSafeIntegerLiteral(value: string): boolean {
  const v = BigInt(value);
  return v >= MIN_SAFE && v <= MAX_SAFE;
}

export function matchInteger(value: string): boolean {
  return INTEGER_RE.test(value) && isSafeIntegerLiteral(value);
}

const FLOAT_RE = /^[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const PURE_INTEGER_RE = /^[+-]?\d+$/;

export function matchFloat(value: string): boolean {
  if (!FLOAT_RE.test(value)) return false;
  if (PURE_INTEGER_RE.test(value)) {
    // 纯整数字面量超出安全整数范围时不匹配 float。
    return isSafeIntegerLiteral(value);
  }
  return Number.isFinite(Number(value));
}

const DATE_RE = /^(\d{2})\/(\d{2})\/(\d{4})$/;

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** 严格 MM/DD/YYYY 的真实公历日期，年份 0001-9999。 */
export function matchDate(value: string): boolean {
  const m = DATE_RE.exec(value);
  if (m === null) return false;
  const month = Number(m[1]);
  const day = Number(m[2]);
  const year = Number(m[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  let lastDay = MONTH_DAYS[month - 1]!;
  if (month === 2 && isLeapYear(year)) lastDay = 29;
  return day <= lastDay;
}

export function matchUrl(value: string): boolean {
  const lower = value.toLowerCase();
  if (!lower.startsWith('http://') && !lower.startsWith('https://')) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== '';
}

const LOCAL_RE = /^[A-Za-z0-9._%+-]+$/;
const DOMAIN_LABEL_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const TLD_RE = /^[A-Za-z]{2,}$/;

export function matchEmail(value: string): boolean {
  const firstAt = value.indexOf('@');
  if (firstAt < 0 || firstAt !== value.lastIndexOf('@')) return false;
  const local = value.slice(0, firstAt);
  const domain = value.slice(firstAt + 1);
  if (!LOCAL_RE.test(local)) return false;
  const labels = domain.split('.');
  if (labels.length < 2) return false;
  for (const label of labels) {
    if (!DOMAIN_LABEL_RE.test(label)) return false;
  }
  return TLD_RE.test(labels[labels.length - 1]!);
}
