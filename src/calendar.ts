/**
 * 公历日期与 America/Chicago 固定规则时区（UTC-6 标准时 / UTC-5 夏令时，
 * 3 月第二个星期日 02:00 拨快，11 月第一个星期日 02:00 拨回）的换算。
 * 内部统一使用“序列日”（1970-01-01 起算的天数）与“Unix 分钟”表示瞬间。
 */

const DAY_MINUTES = 1440;
/** 标准时偏移：UTC = 本地 + 360 分钟。 */
export const CST_OFFSET_MINUTES = 360;
/** 夏令时偏移：UTC = 本地 + 300 分钟。 */
export const CDT_OFFSET_MINUTES = 300;

/** 公历 (y, m, d) -> 序列日（Howard Hinnant 算法）。支持 2008..9999。 */
export function daysFromCivil(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const mp = m > 2 ? m - 3 : m + 9;
  const doy = Math.floor((153 * mp + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** 序列日 -> [y, m, d]。 */
export function civilFromDays(z: number): [number, number, number] {
  const zz = z + 719468;
  const era = Math.floor(zz / 146097);
  const doe = zz - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  );
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return [m <= 2 ? y + 1 : y, m, d];
}

/** 序列日 -> 星期几，0=周一 .. 6=周日。1970-01-01 是周四。 */
export function weekdayOf(serialDay: number): number {
  return (((serialDay + 3) % 7) + 7) % 7;
}

/** 某一年 3 月第二个星期日（春季拨快日）的序列日。 */
export function springForwardDay(year: number): number {
  const mar1 = daysFromCivil(year, 3, 1);
  return mar1 + ((6 - weekdayOf(mar1) + 7) % 7) + 7;
}

/** 某一年 11 月第一个星期日（秋季拨回日）的序列日。 */
export function fallBackDay(year: number): number {
  const nov1 = daysFromCivil(year, 11, 1);
  return nov1 + ((6 - weekdayOf(nov1) + 7) % 7);
}

export const enum LocalKind {
  /** 开放时刻：秋季重复时刻取较早真实瞬间。 */
  Open = 0,
  /** 截止时刻：秋季重复时刻取较晚真实瞬间。 */
  Close = 1,
}

/**
 * 本地日期 + 当日分钟 -> Unix 分钟（UTC 瞬间）。
 * 春季不存在的本地时刻返回 null（整场取消）。
 */
export function localToUtcMinutes(
  serialDay: number,
  minutesOfDay: number,
  kind: LocalKind,
): number | null {
  const [year] = civilFromDays(serialDay);
  const spring = springForwardDay(year);
  const fall = fallBackDay(year);
  let offset: number;
  if (serialDay === spring) {
    if (minutesOfDay < 120) {
      offset = CST_OFFSET_MINUTES;
    } else if (minutesOfDay < 180) {
      return null;
    } else {
      offset = CDT_OFFSET_MINUTES;
    }
  } else if (serialDay === fall) {
    if (minutesOfDay < 60) {
      offset = CDT_OFFSET_MINUTES;
    } else if (minutesOfDay < 120) {
      offset = kind === LocalKind.Open ? CDT_OFFSET_MINUTES : CST_OFFSET_MINUTES;
    } else {
      offset = CST_OFFSET_MINUTES;
    }
  } else {
    offset = serialDay > spring && serialDay < fall ? CDT_OFFSET_MINUTES : CST_OFFSET_MINUTES;
  }
  return serialDay * DAY_MINUTES + minutesOfDay + offset;
}

/** Unix 分钟 -> ISO 8601 字符串（UTC，精确到分钟）。 */
export function utcMinutesToIsoString(utcMinutes: number): string {
  const day = Math.floor(utcMinutes / DAY_MINUTES);
  const minuteOfDay = utcMinutes - day * DAY_MINUTES;
  const [y, m, d] = civilFromDays(day);
  const hh = Math.floor(minuteOfDay / 60);
  const mm = minuteOfDay % 60;
  const pad = (v: number, w: number) => String(v).padStart(w, "0");
  return `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}T${pad(hh, 2)}:${pad(mm, 2)}:00Z`;
}

/** 序列日 -> YYYY-MM-DD。 */
export function serialDayToDateString(serialDay: number): string {
  const [y, m, d] = civilFromDays(serialDay);
  const pad = (v: number) => String(v).padStart(2, "0");
  return `${String(y).padStart(4, "0")}-${pad(m)}-${pad(d)}`;
}
