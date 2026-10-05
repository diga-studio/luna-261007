import type { LocalTime } from "./types.js";

export const MINUTES_PER_DAY = 1440;
export const MINUTES_PER_WEEK = 7 * MINUTES_PER_DAY;

/** 把 YYYY-MM-DD 转为自 1970-01-01 起的连续天数（纯历法运算，忽略时区与夏令时）。 */
export function dateToDayNumber(date: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) {
    throw new Error(`invalid date: ${date}`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  // Howard Hinnant 的 days_from_civil 算法。
  const adjustedYear = month <= 2 ? year - 1 : year;
  const era = Math.floor(adjustedYear / 400);
  const yearOfEra = adjustedYear - era * 400;
  const monthPrime = month > 2 ? month - 3 : month + 9;
  const dayOfYear = Math.floor((153 * monthPrime + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146097 + dayOfEra - 719468;
}

/** 把自 1970-01-01 起的连续天数转回 YYYY-MM-DD。 */
export function dayNumberToDate(dayNumber: number): string {
  const shifted = dayNumber + 719468;
  const era = Math.floor(shifted / 146097);
  const dayOfEra = shifted - era * 146097;
  const yearOfEra = Math.floor(
    (dayOfEra - Math.floor(dayOfEra / 1460) + Math.floor(dayOfEra / 36524) - Math.floor(dayOfEra / 146096)) / 365,
  );
  const year = yearOfEra + era * 400;
  const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const monthPrime = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * monthPrime + 2) / 5) + 1;
  const month = monthPrime < 10 ? monthPrime + 3 : monthPrime - 9;
  const fullYear = month <= 2 ? year + 1 : year;
  const pad = (n: number, width: number) => String(n).padStart(width, "0");
  return `${pad(fullYear, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

/** 本地时间转绝对分钟数（自 1970-01-01 零点起）。 */
export function localTimeToAbsMinute(t: LocalTime): number {
  return dateToDayNumber(t.date) * MINUTES_PER_DAY + t.minute;
}
