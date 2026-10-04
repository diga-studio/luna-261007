import type { CalendarSegment, Minute } from "./types.ts";
import { makeBlock, applyDelta, splitBlock, type Block } from "./block.ts";

/** Target number of intervals per block; blocks grow to at most 2x this before splitting. */
const BLOCK_TARGET = 512;

/**
 * Per-doctor schedule: a static open calendar plus dynamic remaining-capacity
 * intervals stored in blocks covering [calStart, calEnd). Minutes outside that
 * range have capacity 0. Queries scan whole blocks via precomputed aggregates,
 * so a lookup costs O(#blocks + blockSize).
 */
export class DoctorSchedule {
  readonly calStart: Minute;
  readonly calEnd: Minute;
  blocks: Block[] = [];

  constructor(segments: readonly CalendarSegment[]) {
    const segs = [...segments].sort((x, y) => x.start - y.start);
    const starts: number[] = [];
    const rs: number[] = [];
    let prevEnd = -1;
    for (const seg of segs) {
      if (!Number.isInteger(seg.start) || !Number.isInteger(seg.end) || seg.start >= seg.end) {
        throw new RangeError(`invalid segment range [${seg.start}, ${seg.end})`);
      }
      if (!Number.isInteger(seg.capacity) || seg.capacity < 1 || seg.capacity > 8) {
        throw new RangeError(`invalid segment capacity ${seg.capacity}`);
      }
      if (starts.length > 0 && seg.start < prevEnd) {
        throw new RangeError(`overlapping calendar segments at ${seg.start}`);
      }
      if (starts.length === 0) {
        starts.push(seg.start);
        rs.push(seg.capacity);
      } else if (seg.start > prevEnd) {
        starts.push(prevEnd, seg.start);
        rs.push(0, seg.capacity);
      } else if (rs[rs.length - 1] !== seg.capacity) {
        starts.push(seg.start);
        rs.push(seg.capacity);
      }
      prevEnd = seg.end;
    }
    if (starts.length === 0) {
      this.calStart = 0;
      this.calEnd = 0;
      return;
    }
    this.calStart = starts[0]!;
    this.calEnd = prevEnd;
    for (let i = 0; i < starts.length; i += BLOCK_TARGET) {
      const j = Math.min(i + BLOCK_TARGET, starts.length);
      const end = j < starts.length ? starts[j]! : this.calEnd;
      this.blocks.push(makeBlock(starts[i]!, end, starts.slice(i, j), rs.slice(i, j)));
    }
  }

  /** Index of the last block with start <= t (0 when t precedes the first block). */
  private locateBlock(t: Minute): number {
    let lo = 0;
    let hi = this.blocks.length - 1;
    let ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.blocks[mid]!.start <= t) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return ans;
  }

  /** Minimum remaining capacity over [s, e); minutes outside the calendar count as 0. */
  rangeMin(s: Minute, e: Minute): number {
    if (s >= e) return Infinity;
    if (this.blocks.length === 0 || s < this.calStart || e > this.calEnd) return 0;
    let mn = Infinity;
    let i = this.locateBlock(s);
    for (; i < this.blocks.length; i++) {
      const b = this.blocks[i]!;
      if (b.start >= e) break;
      const bs = s > b.start ? s : b.start;
      const be = e < b.end ? e : b.end;
      if (bs >= be) continue;
      if (bs === b.start && be === b.end) {
        if (b.mn < mn) mn = b.mn;
        continue;
      }
      for (let j = this.locateInterval(b, bs); j < b.rs.length; j++) {
        const a = b.starts[j]!;
        if (a >= be) break;
        const r = b.rs[j]!;
        if (r < mn) mn = r;
        if (mn === 0) return 0;
      }
    }
    return mn;
  }

  /** Index of the interval containing minute t inside block b. */
  private locateInterval(b: Block, t: Minute): number {
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

  /** Apply delta to every minute of [s, e). Caller must ensure the range is inside the calendar. */
  apply(s: Minute, e: Minute, delta: number): void {
    let i = this.locateBlock(s);
    for (; i < this.blocks.length; i++) {
      const b = this.blocks[i]!;
      if (b.start >= e) break;
      applyDelta(b, s, e, delta);
      if (b.rs.length > 2 * BLOCK_TARGET) {
        const [left, right] = splitBlock(b);
        this.blocks.splice(i, 1, left, right);
        i++; // both halves already carry the delta; skip the right half
      }
    }
  }

  /**
   * Earliest start t with qs <= t and t + dur <= qe such that every minute of
   * [t, t + dur) has remaining capacity >= 1. Returns null when none exists.
   */
  findEarliest(qs: Minute, qe: Minute, dur: number): Minute | null {
    const lo = qs > this.calStart ? qs : this.calStart;
    const hi = qe < this.calEnd ? qe : this.calEnd;
    if (hi - lo < dur) return null;

    // Invariant: `carry` = length in minutes of the good run ending at the
    // current scan position; the run started at `runStart`.
    let carry = 0;
    let runStart = lo;

    let i = this.locateBlock(lo);
    for (; i < this.blocks.length; i++) {
      const b = this.blocks[i]!;
      if (b.start >= hi) break;
      const bs = lo > b.start ? lo : b.start;
      const be = hi < b.end ? hi : b.end;
      if (bs >= be) continue;
      const full = bs === b.start && be === b.end;
      if (full) {
        if (b.mn >= 1) {
          if (carry === 0) runStart = bs;
          carry += be - bs;
          if (carry >= dur) return runStart;
          continue;
        }
        if (b.mx <= 0) {
          carry = 0;
          continue;
        }
        if (carry + b.pre >= dur) return bs - carry;
        if (b.best < dur) {
          carry = b.suf === b.end - b.start ? carry + (be - bs) : b.suf;
          runStart = be - carry;
          continue;
        }
        // The answer lies inside this mixed block: fall through to the interval scan.
      }
      // Interval-level scan of [bs, be) (partial edge block or mixed block).
      for (let j = this.locateInterval(b, bs); j < b.rs.length; j++) {
        const a = b.starts[j]!;
        if (a >= be) break;
        const z = j + 1 < b.starts.length ? b.starts[j + 1]! : b.end;
        const ca = bs > a ? bs : a;
        const cz = be < z ? be : z;
        if (b.rs[j]! >= 1) {
          if (carry === 0) runStart = ca;
          carry += cz - ca;
          if (carry >= dur) return runStart;
        } else {
          carry = 0;
        }
      }
    }
    return null;
  }
}
