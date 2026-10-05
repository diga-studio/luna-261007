import { Minute } from './types';

export const WEEK_MINUTES = 7 * 24 * 60;
export const WEEKLY_CAP_MINUTES = 2400;

// Unix epoch（1970-01-01 00:00 UTC）是周四；最近的周一 00:00 在 epoch 前 3 天。
const MONDAY_OFFSET_MINUTES = 3 * 24 * 60;

/** 工作周起点（周一 00:00 UTC）对应的周序号。 */
export function weekIndexOf(minute: Minute): number {
  return Math.floor((minute + MONDAY_OFFSET_MINUTES) / WEEK_MINUTES);
}

/** 把半开区间 [start, end) 按工作周切分，返回 周序号 -> 落在该周的分钟数。 */
export function splitByWeek(start: Minute, end: Minute): Map<number, number> {
  const result = new Map<number, number>();
  if (end <= start) return result;
  let cursor = start;
  while (cursor < end) {
    const week = weekIndexOf(cursor);
    const weekEnd = (week + 1) * WEEK_MINUTES - MONDAY_OFFSET_MINUTES;
    const segmentEnd = Math.min(end, weekEnd);
    result.set(week, (result.get(week) ?? 0) + (segmentEnd - cursor));
    cursor = segmentEnd;
  }
  return result;
}

/** 两个半开区间是否重叠。 */
export function overlaps(aStart: Minute, aEnd: Minute, bStart: Minute, bEnd: Minute): boolean {
  return aStart < bEnd && bStart < aEnd;
}
