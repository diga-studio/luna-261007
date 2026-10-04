import type { TimeMs } from './types';

/** 半开区间 [start, end)，end 必须有限（调用方负责把开口端截断到查询范围）。 */
export interface Span {
  start: TimeMs;
  end: TimeMs;
}

/** 合并重叠或首尾相接的区间，返回按 start 升序的最大化合并结果。 */
export function mergeSpans(spans: ReadonlyArray<Span>): Span[] {
  if (spans.length === 0) return [];
  const sorted = spans.slice().sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Span[] = [];
  let curStart = sorted[0]!.start;
  let curEnd = sorted[0]!.end;
  for (let i = 1; i < sorted.length; i++) {
    const s = sorted[i]!;
    if (s.start <= curEnd) {
      if (s.end > curEnd) curEnd = s.end;
    } else {
      out.push({ start: curStart, end: curEnd });
      curStart = s.start;
      curEnd = s.end;
    }
  }
  out.push({ start: curStart, end: curEnd });
  return out;
}

/** 从 base 的各区间中扣除 cuts 覆盖的部分，返回剩余区间（升序、不重叠）。 */
export function subtractSpans(base: ReadonlyArray<Span>, cuts: ReadonlyArray<Span>): Span[] {
  if (base.length === 0) return [];
  if (cuts.length === 0) return base.slice();
  const mergedCuts = mergeSpans(cuts);
  const out: Span[] = [];
  let cutIdx = 0;
  for (const b of base) {
    let cursor = b.start;
    while (cutIdx < mergedCuts.length && mergedCuts[cutIdx]!.end <= cursor) cutIdx++;
    let j = cutIdx;
    while (j < mergedCuts.length && mergedCuts[j]!.start < b.end) {
      const c = mergedCuts[j]!;
      if (c.start > cursor) out.push({ start: cursor, end: Math.min(c.start, b.end) });
      if (c.end > cursor) cursor = c.end;
      if (cursor >= b.end) break;
      j++;
    }
    if (cursor < b.end) out.push({ start: cursor, end: b.end });
  }
  return out;
}

/** 求两个已合并（升序、不重叠）区间列表的交集，结果同样升序、不重叠。 */
export function intersectSpans(a: ReadonlyArray<Span>, b: ReadonlyArray<Span>): Span[] {
  const out: Span[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const s = a[i]!;
    const t = b[j]!;
    const start = Math.max(s.start, t.start);
    const end = Math.min(s.end, t.end);
    if (start < end) out.push({ start, end });
    if (s.end < t.end) i++;
    else j++;
  }
  return out;
}
