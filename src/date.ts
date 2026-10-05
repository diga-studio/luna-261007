/** 内部公历日期工具。所有函数不依赖系统时区，纯历法计算。 */

export interface CivilDate {
  readonly year: number;
  readonly month: number; // 1-12
  readonly day: number; // 1-31
}

const ISO_RE = /^(\d{4,})-(\d{2})-(\d{2})$/;

export function parseIso(iso: string): CivilDate {
  const match = ISO_RE.exec(iso);
  if (match === null) {
    throw new Error(`invalid date: ${JSON.stringify(iso)}`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new Error(`invalid date: ${JSON.stringify(iso)}`);
  }
  return { year, month, day };
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

export function daysInMonth(year: number, month: number): number {
  switch (month) {
    case 2:
      return isLeapYear(year) ? 29 : 28;
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    default:
      return 31;
  }
}

/**
 * 在 date 上加 months 个月：保留原日号；目标月缺该日则取目标月月底。
 * 不沿用任何上月截断结果（每次都以原日期为基准）。
 */
export function addMonths(date: CivilDate, months: number): CivilDate {
  const total = date.year * 12 + (date.month - 1) + months;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  const day = Math.min(date.day, daysInMonth(year, month));
  return { year, month, day };
}

/** 比较两个日期：a<b 返回负数，a==b 返回 0，a>b 返回正数。 */
export function compare(a: CivilDate, b: CivilDate): number {
  if (a.year !== b.year) return a.year - b.year;
  if (a.month !== b.month) return a.month - b.month;
  return a.day - b.day;
}
