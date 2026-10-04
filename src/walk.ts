import { nodeGaussian, hashString, MASK64 } from './prng.js';
import { internalStats } from './stats.js';

/** Number of 1ms steps in 90 days; valid indices are 0..M inclusive. */
export const M = 7_776_000_000;

/** A single random-walk trajectory. */
export interface Walk {
  /** Value at the given index; O(log M), no prior reads required. */
  valueAt(index: number): number;
  /**
   * Lazy iterator yielding `count` consecutive values starting at `start`
   * in increasing index order. Total work for k consumed points is
   * O(k + log M); stopping early performs no further work.
   */
  readRange(start: number, count: number): IterableIterator<number>;
}

/** Hash tags separating the two draw domains (endpoint vs. midpoint). */
const TAG_ENDPOINT = 0x5eed0001n;
const TAG_MIDPOINT = 0x5eed0002n;

/**
 * One descent-stack frame: the value is known at both endpoints of [a, b].
 * `xm` memoizes this node's midpoint value so each tree node is evaluated
 * at most once per iterator (total O(k + log M) draws for k emitted points).
 */
interface Frame {
  a: number;
  b: number;
  xa: number;
  xb: number;
  xm?: number;
}

class WalkImpl implements Walk {
  private readonly seed: bigint;
  private readonly streamHash: bigint;
  private readonly initial: number;
  private readonly sigma: number;
  private readonly rootEnd: number; // X(M), fixed per trajectory

  constructor(seed: number | bigint, streamId: string, initial: number, sigma: number) {
    this.seed = BigInt(seed) & MASK64;
    this.streamHash = hashString(streamId);
    this.initial = initial;
    this.sigma = sigma;
    // X(M) - X(0) ~ N(0, M * sigma^2): the total increment of the walk.
    this.rootEnd =
      initial +
      sigma * Math.sqrt(M) * nodeGaussian(this.seed, this.streamHash, TAG_ENDPOINT, 0, M);
  }

  /**
   * Levy midpoint displacement: given X(a)=xa and X(b)=xb,
   * X(mid) = (xa+xb)/2 + sigma * sqrt(b-a)/2 * Z(a,b), Z ~ N(0,1) keyed by (a,b).
   * Pure function of the tree node, hence bit-identical for every reader.
   */
  private midpoint(a: number, b: number, xa: number, xb: number): number {
    const z = nodeGaussian(this.seed, this.streamHash, TAG_MIDPOINT, a, b);
    return (xa + xb) / 2 + this.sigma * (Math.sqrt(b - a) / 2) * z;
  }

  /** Midpoint value of a frame, computed once and cached on the frame. */
  private frameMidpoint(f: Frame): number {
    if (f.xm === undefined) {
      f.xm = this.midpoint(f.a, f.b, f.xa, f.xb);
    }
    return f.xm;
  }

  valueAt(index: number): number {
    if (index === 0) return this.initial;
    if (index === M) return this.rootEnd;
    let a = 0;
    let b = M;
    let xa = this.initial;
    let xb = this.rootEnd;
    while (b - a > 1) {
      const mid = a + Math.floor((b - a) / 2);
      const xm = this.midpoint(a, b, xa, xb);
      if (index <= mid) {
        b = mid;
        xb = xm;
      } else {
        a = mid;
        xa = xm;
      }
    }
    return index === a ? xa : xb;
  }

  *readRange(start: number, count: number): IterableIterator<number> {
    const stack: Frame[] = [{ a: 0, b: M, xa: this.initial, xb: this.rootEnd }];
    let n = start;
    for (let emitted = 0; emitted < count; emitted++, n++) {
      // Pop frames whose interval no longer contains n (amortized O(1)).
      let top = stack[stack.length - 1];
      while (top.b < n) {
        stack.pop();
        top = stack[stack.length - 1];
      }
      // Descend from the deepest known ancestor down to the unit interval.
      while (top.b - top.a > 1) {
        const mid = top.a + Math.floor((top.b - top.a) / 2);
        const xm = this.frameMidpoint(top);
        top =
          n <= mid
            ? { a: top.a, b: mid, xa: top.xa, xb: xm }
            : { a: mid, b: top.b, xa: xm, xb: top.xb };
        stack.push(top);
      }
      if (stack.length > internalStats.maxStackDepth) {
        internalStats.maxStackDepth = stack.length;
      }
      yield n === top.a ? top.xa : top.xb;
    }
  }
}

/**
 * Create a walk instance. Construction performs a single PRNG draw (O(1)).
 * `seed` is a 64-bit integer (number or bigint); `sigma` must be positive.
 */
export function createWalk(
  seed: number | bigint,
  streamId: string,
  initial: number,
  sigma: number,
): Walk {
  return new WalkImpl(seed, streamId, initial, sigma);
}
