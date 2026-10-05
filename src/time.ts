import type { Minute } from './types.ts';

export const WEEK_MINUTES = 7 * 24 * 60; // 10080
export const WEEKLY_CAP_MINUTES = 2400;
export const INVITE_TTL_MINUTES = 120;

/** 某时刻所属工作周（周一 00:00 起）的序号。 */
export function weekOf(min: Minute): number {
  return Math.floor(min / WEEK_MINUTES);
}

export interface WeekSlice {
  week: number;
  minutes: number;
}

/** 把 [startMin, endMin) 按工作周切分，返回每周落到的分钟数。 */
export function splitByWeek(startMin: Minute, endMin: Minute): WeekSlice[] {
  if (endMin <= startMin) return [];
  const slices: WeekSlice[] = [];
  let cursor = startMin;
  while (cursor < endMin) {
    const week = weekOf(cursor);
    const weekEnd = (week + 1) * WEEK_MINUTES;
    const sliceEnd = Math.min(endMin, weekEnd);
    slices.push({ week, minutes: sliceEnd - cursor });
    cursor = sliceEnd;
  }
  return slices;
}

/** 两个半开区间是否重叠。 */
export function overlaps(
  aStart: Minute,
  aEnd: Minute,
  bStart: Minute,
  bEnd: Minute,
): boolean {
  return aStart < bEnd && bStart < aEnd;
}
