/**
 * 公历日期工具：日期字符串 <-> 自 2008-01-01 起的天数（dayNumber）。
 * weekday 约定：0=周一 … 6=周日。
 * 算法：Howard Hinnant 的 days_from_civil / civil_from_days。
 */

const MIN_YEAR = 2008;
const MAX_YEAR = 9999;

/** 1970-01-01 起算的天数。 */
function daysFromCivil(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400; // [0, 399]
  const mp = m > 2 ? m - 3 : m + 9; // [0, 11]
  const doy = Math.floor((153 * mp + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function civilFromDays(z: number): { y: number; m: number; d: number } {
  const zz = z + 719468;
  const era = Math.floor(zz / 146097);
  const doe = zz - era * 146097; // [0, 146096]
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153); // [0, 11]
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return { y: m <= 2 ? y + 1 : y, m, d };
}

const EPOCH = daysFromCivil(2008, 1, 1);

function isLeap(y: number): boolean {
  return y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
}

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 把 YYYY-MM-DD 解析为 dayNumber；非法日期抛出错误。 */
export function parseDate(text: string): number {
  const m = DATE_RE.exec(text);
  if (!m) throw new Error(`invalid date format: ${text}`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < MIN_YEAR || y > MAX_YEAR) throw new Error(`year out of range: ${text}`);
  if (mo < 1 || mo > 12) throw new Error(`month out of range: ${text}`);
  const dim = MONTH_DAYS[mo - 1]! + (mo === 2 && isLeap(y) ? 1 : 0);
  if (d < 1 || d > dim) throw new Error(`day out of range: ${text}`);
  return daysFromCivil(y, mo, d) - EPOCH;
}

/** 把 dayNumber 格式化为 YYYY-MM-DD。 */
export function formatDate(dayNumber: number): string {
  const { y, m, d } = civilFromDays(dayNumber + EPOCH);
  const mm = String(m).padStart(2, "0");
  const dd = String(d).padStart(2, "0");
  return `${String(y).padStart(4, "0")}-${mm}-${dd}`;
}

/** dayNumber 对应的星期几（0=周一 … 6=周日）。2008-01-01 是周二。 */
export function weekdayOf(dayNumber: number): number {
  return (((dayNumber + 1) % 7) + 7) % 7;
}

/** 某年 3 月第二个星期日的 dayNumber。 */
export function secondSundayOfMarch(year: number): number {
  const mar1 = daysFromCivil(year, 3, 1) - EPOCH;
  const offset = (6 - weekdayOf(mar1) + 7) % 7;
  return mar1 + offset + 7;
}

/** 某年 11 月第一个星期日的 dayNumber。 */
export function firstSundayOfNovember(year: number): number {
  const nov1 = daysFromCivil(year, 11, 1) - EPOCH;
  const offset = (6 - weekdayOf(nov1) + 7) % 7;
  return nov1 + offset;
}

/** dayNumber 对应的公历年。 */
export function yearOf(dayNumber: number): number {
  return civilFromDays(dayNumber + EPOCH).y;
}
