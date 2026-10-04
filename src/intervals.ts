import type { Interval, Millis } from './types.js';

/** 合并重叠或首尾相接的时段（输入可无序、可重叠），返回有序不相交时段 */
export function mergeIntervals(intervals: readonly Interval[]): Interval[] {
  if (intervals.length === 0) return [];
  const sorted = intervals.slice().sort((x, y) => x.start - y.start || x.end - y.end);
  const out: Interval[] = [];
  let cur = { start: sorted[0]!.start, end: sorted[0]!.end };
  for (let i = 1; i < sorted.length; i++) {
    const iv = sorted[i]!;
    if (iv.start <= cur.end) {
      if (iv.end > cur.end) cur.end = iv.end;
    } else {
      out.push(cur);
      cur = { start: iv.start, end: iv.end };
    }
  }
  out.push(cur);
  return out;
}

/** 两个已合并（有序不相交）时段列表的交集，结果同样有序不相交 */
export function intersectIntervals(a: readonly Interval[], b: readonly Interval[]): Interval[] {
  const out: Interval[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const x = a[i]!;
    const y = b[j]!;
    const start = Math.max(x.start, y.start);
    const end = Math.min(x.end, y.end);
    if (start < end) out.push({ start, end });
    if (x.end < y.end) i++;
    else j++;
  }
  return out;
}

/** 从已合并时段列表 source 中扣除 subtract 覆盖的部分（subtract 可未合并） */
export function subtractIntervals(source: readonly Interval[], subtract: readonly Interval[]): Interval[] {
  if (source.length === 0) return [];
  const holes = mergeIntervals(subtract);
  if (holes.length === 0) return source.slice();
  const out: Interval[] = [];
  let h = 0;
  for (const seg of source) {
    let curStart = seg.start;
    while (h < holes.length && holes[h]!.end <= curStart) h++;
    let k = h;
    while (k < holes.length && holes[k]!.start < seg.end) {
      const hole = holes[k]!;
      if (hole.start > curStart) {
        out.push({ start: curStart, end: Math.min(hole.start, seg.end) });
      }
      if (hole.end > curStart) curStart = Math.max(curStart, hole.end);
      if (curStart >= seg.end) break;
      k++;
    }
    if (curStart < seg.end) out.push({ start: curStart, end: seg.end });
  }
  return out;
}

/** 将时段裁剪到 [start, end) 内，完全在外则返回 null */
export function clampInterval(interval: Interval, start: Millis, end: Millis): Interval | null {
  const s = Math.max(interval.start, start);
  const e = Math.min(interval.end, end);
  return s < e ? { start: s, end: e } : null;
}
