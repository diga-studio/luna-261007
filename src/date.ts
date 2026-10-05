// RFC3339 时间戳规范化：仅接受带 UTC 标记（Z/z）或数值偏移（±HH:MM）的输入，
// 小数秒 0-3 位；输出统一为 UTC、固定 3 位小数秒。
// 非法日历日期、闰秒、缺时区均失败；全程使用民用日期算法，不依赖机器时区。

const PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?([Zz]|[+-]\d{2}:\d{2})$/;

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  const common = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return common[month - 1]!;
}

/** Howard Hinnant 的 days_from_civil：返回自 1970-01-01 起的天数。 */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = month > 2 ? month - 3 : month + 9;
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** civil_from_days：daysFromCivil 的逆运算。 */
function civilFromDays(z: number): [number, number, number] {
  const zz = z + 719468;
  const era = Math.floor(zz / 146097);
  const doe = zz - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  return [month <= 2 ? yoe + era * 400 + 1 : yoe + era * 400, month, day];
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/**
 * 规范化 RFC3339 时间戳；非法输入返回 null。
 * 输出形如 "2024-03-01T02:30:00.000Z"。
 */
export function normalizeDate(input: string): string | null {
  if (typeof input !== "string") return null;
  const match = PATTERN.exec(input);
  if (match === null) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fraction = match[7] ?? "";
  const zone = match[8]!;

  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59) return null;
  if (second > 59) return null; // 拒绝闰秒（60）

  let offsetMinutes = 0;
  if (zone !== "Z" && zone !== "z") {
    const sign = zone.startsWith("-") ? -1 : 1;
    const offHour = Number(zone.slice(1, 3));
    const offMinute = Number(zone.slice(4, 6));
    if (offHour > 23 || offMinute > 59) return null;
    offsetMinutes = sign * (offHour * 60 + offMinute);
  }

  const millis = Number(fraction.padEnd(3, "0") || "0");
  const days = daysFromCivil(year, month, day);
  const totalMillis =
    ((days * 24 + hour) * 60 + minute - offsetMinutes) * 60_000 + second * 1000 + millis;

  const outDays = Math.floor(totalMillis / 86_400_000);
  const rem = totalMillis - outDays * 86_400_000;
  const [outYear, outMonth, outDay] = civilFromDays(outDays);
  const outHour = Math.floor(rem / 3_600_000);
  const outMinute = Math.floor((rem % 3_600_000) / 60_000);
  const outSecond = Math.floor((rem % 60_000) / 1000);
  const outMillis = rem % 1000;

  return (
    `${pad(outYear, 4)}-${pad(outMonth, 2)}-${pad(outDay, 2)}` +
    `T${pad(outHour, 2)}:${pad(outMinute, 2)}:${pad(outSecond, 2)}.${pad(outMillis, 3)}Z`
  );
}
