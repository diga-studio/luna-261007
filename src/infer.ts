import type { ColumnType } from "./types.js";

/** 判型优先级：取第一个有资格（非空样本命中率 ≥ 80%）的类型。 */
export const TYPE_PRIORITY: readonly Exclude<ColumnType, "text">[] = [
  "boolean",
  "integer",
  "float",
  "date",
  "url",
  "email",
];

/** 首尾含 Unicode White_Space 字符的非空值只能匹配 text。 */
const EDGE_WHITESPACE = /^[\p{White_Space}]|[\p{White_Space}]$/u;

const BOOLEAN_RE = /^(?:true|false)$/i;
const INTEGER_RE = /^[+-]?\d+$/;
/** 整数部分必需；小数部分若有则点后至少一位；指数可带符号且至少一位。 */
const FLOAT_RE = /^[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const DATE_RE = /^(\d{2})\/(\d{2})\/(\d{4})$/;
const URL_PREFIX_RE = /^https?:\/\//i;
const EMAIL_LOCAL_RE = /^[A-Za-z0-9._%+-]+$/;
const EMAIL_LABEL_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const EMAIL_TLD_RE = /^[A-Za-z]{2,}$/;

const MAX_SAFE = 9007199254740991n;
const MIN_SAFE = -9007199254740991n;

function isSafeIntegerLiteral(raw: string): boolean {
  // 字面量形如 [+-]?digits，BigInt 可精确解析。
  const v = BigInt(raw);
  return v >= MIN_SAFE && v <= MAX_SAFE;
}

export function matchBoolean(raw: string): boolean {
  return BOOLEAN_RE.test(raw);
}

export function matchInteger(raw: string): boolean {
  return INTEGER_RE.test(raw) && isSafeIntegerLiteral(raw);
}

export function matchFloat(raw: string): boolean {
  if (!FLOAT_RE.test(raw)) return false;
  // 超安全范围的纯整数字面量不匹配 float。
  if (INTEGER_RE.test(raw)) return isSafeIntegerLiteral(raw);
  // 数值必须有限（如 1e999 溢出为 Infinity，不匹配）。
  return Number.isFinite(Number(raw));
}

/** 严格 MM/DD/YYYY 的真实公历日期，年份 0001–9999。 */
export function matchDate(raw: string): boolean {
  const m = DATE_RE.exec(raw);
  if (m === null) return false;
  const month = Number(m[1]);
  const day = Number(m[2]);
  const year = Number(m[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1]!;
}

/** WHATWG 语义，仅 http(s) 且主机非空；scheme 开头不区分大小写。 */
export function matchUrl(raw: string): boolean {
  if (!URL_PREFIX_RE.test(raw)) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    url.hostname.length > 0
  );
}

export function matchEmail(raw: string): boolean {
  const at = raw.indexOf("@");
  if (at <= 0 || at !== raw.lastIndexOf("@")) return false;
  const local = raw.slice(0, at);
  const domain = raw.slice(at + 1);
  if (!EMAIL_LOCAL_RE.test(local)) return false;
  const labels = domain.split(".");
  if (labels.length < 2) return false;
  for (const label of labels) {
    if (!EMAIL_LABEL_RE.test(label)) return false;
  }
  return EMAIL_TLD_RE.test(labels[labels.length - 1]!);
}

const MATCHERS: Record<Exclude<ColumnType, "text">, (raw: string) => boolean> =
  {
    boolean: matchBoolean,
    integer: matchInteger,
    float: matchFloat,
    date: matchDate,
    url: matchUrl,
    email: matchEmail,
  };

/** 非空原文是否命中某非 text 类型（含首尾空白守卫）。 */
export function matchType(
  raw: string,
  type: Exclude<ColumnType, "text">,
): boolean {
  if (raw.length === 0) return false;
  if (EDGE_WHITESPACE.test(raw)) return false;
  return MATCHERS[type](raw);
}

/** 单列采样统计与判型。 */
export class ColumnInferer {
  private nonEmpty = 0;
  private readonly hits = new Map<Exclude<ColumnType, "text">, number>(
    TYPE_PRIORITY.map((t) => [t, 0]),
  );

  /** 记录一个非空样本值（原文，未裁剪）。 */
  addSample(value: string): void {
    this.nonEmpty++;
    for (const t of TYPE_PRIORITY) {
      if (matchType(value, t)) this.hits.set(t, this.hits.get(t)! + 1);
    }
  }

  /** 记录一个空值样本（仅占采样名额，不参与命中率）。 */
  addEmpty(): void {
    // 空值不计入分母，无需统计。
  }

  /** 采样结束后给出判定类型；全空列为 text。 */
  decide(): ColumnType {
    if (this.nonEmpty === 0) return "text";
    for (const t of TYPE_PRIORITY) {
      if (this.hits.get(t)! / this.nonEmpty >= 0.8) return t;
    }
    return "text";
  }
}

/**
 * 按判定类型转换单元格。
 * 空值输出 null；无法转换的非空值返回 ok:false（调用方保留原文并告警）。
 */
export function convertCell(
  raw: string,
  type: ColumnType,
): { ok: true; value: unknown } | { ok: false } {
  if (raw === "") return { ok: true, value: null };
  switch (type) {
    case "boolean":
      if (!matchType(raw, "boolean")) return { ok: false };
      return { ok: true, value: raw.toLowerCase() === "true" };
    case "integer":
      if (!matchType(raw, "integer")) return { ok: false };
      return { ok: true, value: Number(raw) };
    case "float":
      if (!matchType(raw, "float")) return { ok: false };
      return { ok: true, value: Number(raw) };
    case "date":
    case "url":
    case "email":
      // 输出保持原文，但不合类型的非空值视为转换失败（保留原文并告警）。
      if (!matchType(raw, type)) return { ok: false };
      return { ok: true, value: raw };
    case "text":
      return { ok: true, value: raw };
  }
}
