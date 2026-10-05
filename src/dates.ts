/** UTC 自然日工具。内部统一使用 'YYYY-MM-DD' 字符串，字典序即时间序。 */

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseDate(date: string): { year: number; month: number; day: number } {
  const m = DATE_RE.exec(date);
  if (!m) throw new RangeError(`invalid date, expected YYYY-MM-DD: ${date}`);
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

export function formatDate(year: number, month: number, day: number): string {
  const y = String(year).padStart(4, '0');
  const mo = String(month).padStart(2, '0');
  const d = String(day).padStart(2, '0');
  return `${y}-${mo}-${d}`;
}

export function daysInMonth(year: number, month1to12: number): number {
  return new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
}

export function assertValidDate(date: string, field: string): void {
  const { year, month, day } = parseDate(date);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new RangeError(`invalid ${field}: ${date}`);
  }
}

/** 以锚点日号为基准加 n 个月；目标月没有该日号时取该月最后一天，锚点本身不变。 */
export function addMonthsClamped(date: string, months: number): string {
  const { year, month, day } = parseDate(date);
  const total = year * 12 + (month - 1) + months;
  const newYear = Math.floor(total / 12);
  const newMonth = (total % 12) + 1;
  const newDay = Math.min(day, daysInMonth(newYear, newMonth));
  return formatDate(newYear, newMonth, newDay);
}
