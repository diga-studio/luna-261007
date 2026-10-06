/**
 * 固定的 America/Chicago 规则：
 * 标准时间 UTC-6，夏令时 UTC-5；
 * 3 月第二个星期日 02:00 跳到 03:00，11 月第一个星期日 02:00 退回 01:00。
 * 瞬间用“自 2008-01-01T00:00:00Z 起的分钟数”表示（整数，Number 精确范围内）。
 */
import {
  formatDate,
  firstSundayOfNovember,
  secondSundayOfMarch,
  yearOf,
} from "./date";

export const enum LocalMode {
  /** 开放时刻：秋季重复时刻取较早真实瞬间。 */
  Open = 0,
  /** 截止时刻：秋季重复时刻取较晚真实瞬间。 */
  Close = 1,
}

const CST_OFFSET_MIN = 360; // UTC = local + 360
const CDT_OFFSET_MIN = 300; // UTC = local + 300
const MINUTES_PER_DAY = 1440;

/**
 * 把本地时间（dayNumber + 当日分钟）解析为 UTC 分钟数。
 * 落在春季不存在的本地时刻 [02:00, 03:00) 时返回 null。
 * 秋季重复时刻 [01:00, 02:00) 按 mode 取较早/较晚真实瞬间。
 */
export function localToUtc(
  dayNumber: number,
  minuteOfDay: number,
  mode: LocalMode,
): number | null {
  const year = yearOf(dayNumber);
  const t = dayNumber * MINUTES_PER_DAY + minuteOfDay;
  const gapStart = secondSundayOfMarch(year) * MINUTES_PER_DAY + 120;
  const gapEnd = gapStart + 60;
  const ambigStart = firstSundayOfNovember(year) * MINUTES_PER_DAY + 60;
  const ambigEnd = ambigStart + 60;
  if (t >= gapStart && t < gapEnd) return null;
  if (t >= ambigStart && t < ambigEnd) {
    return t + (mode === LocalMode.Open ? CDT_OFFSET_MIN : CST_OFFSET_MIN);
  }
  const dst = t >= gapEnd && t < ambigStart;
  return t + (dst ? CDT_OFFSET_MIN : CST_OFFSET_MIN);
}

/** 把 UTC 分钟数格式化为 ISO 8601 字符串（秒位为 00）。 */
export function formatUtcInstant(utcMinutes: number): string {
  const day = Math.floor(utcMinutes / MINUTES_PER_DAY);
  const minute = utcMinutes - day * MINUTES_PER_DAY;
  const hh = String(Math.floor(minute / 60)).padStart(2, "0");
  const mm = String(minute % 60).padStart(2, "0");
  return `${formatDate(day)}T${hh}:${mm}:00Z`;
}
