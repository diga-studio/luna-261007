import { Frequency, UtcDate } from './types';

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 24 * 60 * 60 * 1000;

interface Ymd {
  y: number;
  m: number; // 1-12
  d: number;
}

function parse(date: UtcDate): Ymd {
  const match = DATE_RE.exec(date);
  if (!match) throw new Error(`invalid date: ${date}`);
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) {
    throw new Error(`invalid date: ${date}`);
  }
  return { y, m, d };
}

function format({ y, m, d }: Ymd): UtcDate {
  const mm = String(m).padStart(2, '0');
  const dd = String(d).padStart(2, '0');
  return `${y}-${mm}-${dd}`;
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** 月份差：(y2,m2) - (y1,m1)，单位月 */
function diffMonths(y1: number, m1: number, y2: number, m2: number): number {
  return (y2 - y1) * 12 + (m2 - m1);
}

/** 锚点日号在目标月的落点：目标月没有该日号时取月末 */
function clampDay(y: number, m: number, anchorDay: number): number {
  return Math.min(anchorDay, daysInMonth(y, m));
}

function stepMonths(frequency: Frequency): number {
  switch (frequency) {
    case 'monthly':
      return 1;
    case 'quarterly':
      return 3;
    case 'yearly':
      return 12;
    default:
      throw new Error(`no step for frequency: ${frequency}`);
  }
}

/** 校验并规范化 UTC 日期字符串 */
export function normalizeDate(date: UtcDate): UtcDate {
  return format(parse(date));
}

/** 前一天（UTC 自然日） */
export function prevDay(date: UtcDate): UtcDate {
  const { y, m, d } = parse(date);
  const t = new Date(Date.UTC(y, m - 1, d) - DAY_MS);
  return format({ y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() });
}

/** 以首个到期日为锚点，计算第 index 期（0 起）的到期日 */
export function periodDueDate(firstDue: UtcDate, frequency: Frequency, index: number): UtcDate {
  if (index < 0) throw new Error(`negative index: ${index}`);
  const anchor = parse(firstDue);
  if (frequency === 'once') {
    if (index > 0) throw new Error('once frequency has only one period');
    return format(anchor);
  }
  const step = stepMonths(frequency);
  const totalMonths = anchor.m - 1 + index * step;
  const y = anchor.y + Math.floor(totalMonths / 12);
  const m = (totalMonths % 12) + 1;
  return format({ y, m, d: clampDay(y, m, anchor.d) });
}

/**
 * 到期日 <= limit（且 <= endDate）的期次数。
 */
function countDueLE(
  firstDue: UtcDate,
  endDate: UtcDate,
  frequency: Frequency,
  limit: UtcDate
): number {
  const cap = endDate < limit ? endDate : limit;
  if (firstDue > cap) return 0;
  if (frequency === 'once') return 1;
  const anchor = parse(firstDue);
  const bound = parse(cap);
  const step = stepMonths(frequency);
  const months = diffMonths(anchor.y, anchor.m, bound.y, bound.m);
  let k = Math.floor(months / step);
  // 锚点日号 clamp 只影响日号，修正量至多为 1
  while (k > 0 && periodDueDate(firstDue, frequency, k) > cap) k--;
  while (periodDueDate(firstDue, frequency, k + 1) <= cap) k++;
  return k + 1;
}

/**
 * 统计某规则到期日落在 [rangeStart, rangeEnd]（含两端）且不超过 endDate 的期次数。
 * 不逐期展开，O(1) 计算。
 */
export function countPeriodsInRange(
  firstDue: UtcDate,
  endDate: UtcDate,
  frequency: Frequency,
  rangeStart: UtcDate,
  rangeEnd: UtcDate
): number {
  if (rangeStart > rangeEnd) throw new Error(`empty range: ${rangeStart}..${rangeEnd}`);
  const upper = countDueLE(firstDue, endDate, frequency, rangeEnd);
  const lower = countDueLE(firstDue, endDate, frequency, prevDay(rangeStart));
  return upper - lower;
}

/** 枚举规则在区间内的全部到期日（测试与小规模核算用） */
export function enumeratePeriods(
  firstDue: UtcDate,
  endDate: UtcDate,
  frequency: Frequency
): UtcDate[] {
  const out: UtcDate[] = [];
  if (firstDue > endDate) return out;
  if (frequency === 'once') return [firstDue];
  for (let k = 0; ; k++) {
    const due = periodDueDate(firstDue, frequency, k);
    if (due > endDate) break;
    out.push(due);
    if (k > 100000) throw new Error('too many periods');
  }
  return out;
}
