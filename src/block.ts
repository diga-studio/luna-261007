/**
 * A block holds a run of consecutive uniform-remaining-capacity intervals.
 * Interval i covers [starts[i], starts[i+1]) with remaining capacity rs[i];
 * the last interval ends at `end`. Blocks are the unit of aggregation for
 * fast earliest-slot scans.
 */
export interface Block {
  /** Block start minute (=== starts[0]). */
  start: number;
  /** Block end minute (exclusive). */
  end: number;
  /** Interval start minutes, strictly increasing, starts[0] === start. */
  starts: number[];
  /** Remaining capacity per interval, values in [0, 8]. */
  rs: number[];
  /** Aggregates over the whole block. "good" means remaining >= 1. */
  mn: number;
  mx: number;
  /** Good-run length in minutes from the block's left edge. */
  pre: number;
  /** Good-run length in minutes from the block's right edge. */
  suf: number;
  /** Longest good-run length in minutes anywhere inside the block. */
  best: number;
}

export function makeBlock(start: number, end: number, starts: number[], rs: number[]): Block {
  const b: Block = { start, end, starts, rs, mn: 0, mx: 0, pre: 0, suf: 0, best: 0 };
  recompute(b);
  return b;
}

/** Recompute mn/mx/pre/suf/best from starts/rs. */
export function recompute(b: Block): void {
  const n = b.rs.length;
  let mn = Infinity;
  let mx = -Infinity;
  let pre = 0;
  let preDone = false;
  let suf = 0;
  let best = 0;
  let run = 0;
  for (let i = 0; i < n; i++) {
    const r = b.rs[i]!;
    if (r < mn) mn = r;
    if (r > mx) mx = r;
    const a = b.starts[i]!;
    const z = i + 1 < n ? b.starts[i + 1]! : b.end;
    const len = z - a;
    if (r >= 1) {
      run += len;
      if (!preDone) pre += len;
      suf += len;
      if (run > best) best = run;
    } else {
      run = 0;
      preDone = true;
      suf = 0;
    }
  }
  b.mn = mn;
  b.mx = mx;
  b.pre = pre;
  b.suf = suf;
  b.best = best;
}

/** Index of the interval containing minute t inside block b. */
function locateInterval(b: Block, t: number): number {
  let lo = 0;
  let hi = b.starts.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (b.starts[mid]! <= t) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/**
 * Ensure an interval boundary exists exactly at t (must lie inside the
 * block's range). Returns the index of the interval starting at t.
 * Mutates the arrays in place; aggregates are NOT updated here.
 */
function insertBoundary(b: Block, t: number): number {
  if (t >= b.end) return b.rs.length;
  const i = locateInterval(b, t);
  if (b.starts[i] === t) return i;
  b.starts.splice(i + 1, 0, t);
  b.rs.splice(i + 1, 0, b.rs[i]!);
  return i + 1;
}

/**
 * Apply delta (-1 or +1) to every minute of [s, e) inside this block,
 * splitting intervals at s and e as needed. Caller guarantees the block
 * intersects [s, e). Works in place to avoid allocation churn, then
 * recomputes aggregates.
 */
export function applyDelta(b: Block, s: number, e: number, delta: number): void {
  const ss = s > b.start ? s : b.start;
  const ee = e < b.end ? e : b.end;
  const lo = insertBoundary(b, ss);
  const hi = insertBoundary(b, ee);
  for (let i = lo; i < hi; i++) {
    b.rs[i] = b.rs[i]! + delta;
  }
  recompute(b);
}

/** Split an oversized block into two roughly equal halves (by interval count). */
export function splitBlock(b: Block): [Block, Block] {
  const n = b.rs.length;
  const mid = n >> 1;
  const midPoint = b.starts[mid]!;
  const left = makeBlock(b.start, midPoint, b.starts.slice(0, mid), b.rs.slice(0, mid));
  const right = makeBlock(midPoint, b.end, b.starts.slice(mid), b.rs.slice(mid));
  return [left, right];
}
