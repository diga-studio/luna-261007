import { addMonthsClamped, parseDate } from './dates.js';
import type { Frequency } from './types.js';

const STEP_MONTHS: Record<Frequency, number> = {
  once: 0,
  monthly: 1,
  quarterly: 3,
  yearly: 12,
};

/** 第 n 期（n 从 0 起）的到期日；'once' 只有第 0 期。 */
export function dueDateAt(firstDueDate: string, frequency: Frequency, n: number): string {
  if (frequency === 'once') {
    if (n !== 0) throw new RangeError(`once rule has no period ${n}`);
    return firstDueDate;
  }
  return addMonthsClamped(firstDueDate, n * STEP_MONTHS[frequency]);
}

function monthsBetween(a: string, b: string): number {
  const pa = parseDate(a);
  const pb = parseDate(b);
  return (pb.year - pa.year) * 12 + (pb.month - pa.month);
}

/** 统计到期日落在 [rangeStart, rangeEnd]（含两端）且不晚于 ruleEndDate 的期次数。 */
export function countDueDates(
  firstDueDate: string,
  ruleEndDate: string,
  frequency: Frequency,
  rangeStart: string,
  rangeEnd: string,
): number {
  const lo_bound = rangeStart > firstDueDate ? rangeStart : firstDueDate;
  const hi_bound = ruleEndDate < rangeEnd ? ruleEndDate : rangeEnd;
  if (lo_bound > hi_bound) return 0;
  if (frequency === 'once') {
    return firstDueDate >= lo_bound && firstDueDate <= hi_bound ? 1 : 0;
  }

  const step = STEP_MONTHS[frequency];
  // due(n) 严格递增；upperN 处的到期日必然晚于 hi_bound，作为二分上界。
  const upperN = Math.floor(monthsBetween(firstDueDate, hi_bound) / step) + 1;

  // lo：最小 n 使 due(n) >= lo_bound（upperN 处谓词必真）
  let lo = 0;
  let hi = upperN;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (addMonthsClamped(firstDueDate, mid * step) >= lo_bound) hi = mid;
    else lo = mid + 1;
  }
  const first = lo;

  // last：最大 n 使 due(n) <= hi_bound（n=0 处谓词必真，因为 firstDueDate <= hi_bound）
  lo = 0;
  hi = upperN;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (addMonthsClamped(firstDueDate, mid * step) <= hi_bound) lo = mid;
    else hi = mid - 1;
  }
  const last = lo;

  return first <= last ? last - first + 1 : 0;
}

/** 校验某个到期日是否确为该规则的一个期次（且不晚于规则终止日）。 */
export function isPeriodDueDate(
  firstDueDate: string,
  ruleEndDate: string,
  frequency: Frequency,
  dueDate: string,
): boolean {
  if (dueDate < firstDueDate || dueDate > ruleEndDate) return false;
  if (frequency === 'once') return dueDate === firstDueDate;
  const step = STEP_MONTHS[frequency];
  const months = monthsBetween(firstDueDate, dueDate);
  if (months % step !== 0) return false;
  return addMonthsClamped(firstDueDate, months) === dueDate;
}
