/**
 * Random-access Gaussian random walk over indices 0..M via Brownian-bridge
 * bisection. See DESIGN.md for why this yields the exact joint distribution
 * and why out-of-order reads are bit-identical.
 */

import { instanceKey, nodeGaussian } from "./hash";

/** Number of 1ms steps: 90 days. Valid indices are 0..M inclusive. */
export const M = 7_776_000_000;

/** Node id reserved for the root endpoint X(M); midpoints only use 0..M-1. */
const ROOT_NODE_ID = BigInt(M);

export interface Walk {
  /** Value at any index in [0, M]. O(log M) work, no prior reads required. */
  valueAt(index: number): number;
  /**
   * Lazy iterator yielding count consecutive values starting at start,
   * in increasing index order. Total work O(count + log M) if fully consumed;
   * stopping early does not generate the remainder.
   */
  readRange(start: number, count: number): IterableIterator<number>;
  /** Number of Gaussian node evaluations performed so far (work evidence). */
  readonly nodeEvals: number;
  /** Deepest iterator stack observed so far (space evidence, O(log M)). */
  readonly maxIteratorDepth: number;
}

interface Frame {
  lo: number;
  hi: number;
  vLo: number;
  vHi: number;
}

class WalkImpl implements Walk {
  private readonly key: bigint;
  private readonly xM: number;
  nodeEvals = 0;
  maxIteratorDepth = 0;

  constructor(
    seed: bigint | number,
    streamId: string,
    private readonly initial: number,
    private readonly sigma: number,
  ) {
    this.key = instanceKey(BigInt(seed), streamId);
    this.xM = initial + sigma * Math.sqrt(M) * this.gaussianAt(ROOT_NODE_ID);
  }

  private gaussianAt(nodeId: bigint): number {
    this.nodeEvals++;
    return nodeGaussian(this.key, nodeId);
  }

  /**
   * Value at the midpoint of [lo, hi] given the endpoint values.
   * Conditional law of a Gaussian random walk: linear-interpolation mean,
   * variance (m-lo)*(hi-m)/(hi-lo) * sigma^2. Pure function of the interval,
   * so every reader computes the identical double.
   */
  private midpointValue(lo: number, hi: number, vLo: number, vHi: number): { m: number; vM: number } {
    const m = Math.floor((lo + hi) / 2);
    const t = (m - lo) / (hi - lo);
    const sd = this.sigma * Math.sqrt(t * (hi - m));
    const vM = vLo + t * (vHi - vLo) + sd * this.gaussianAt(BigInt(m));
    return { m, vM };
  }

  valueAt(index: number): number {
    if (!Number.isInteger(index) || index < 0 || index > M) {
      throw new RangeError(`index out of range: ${index}`);
    }
    let lo = 0, hi = M, vLo = this.initial, vHi = this.xM;
    while (hi - lo >= 2) {
      const { m, vM } = this.midpointValue(lo, hi, vLo, vHi);
      if (index <= m) {
        hi = m; vHi = vM;
      } else {
        lo = m; vLo = vM;
      }
    }
    return index === lo ? vLo : vHi;
  }

  *readRange(start: number, count: number): IterableIterator<number> {
    if (!Number.isInteger(start) || !Number.isInteger(count) ||
        start < 0 || count < 0 || start + count - 1 > M) {
      throw new RangeError(`invalid range: start=${start} count=${count}`);
    }
    if (count === 0) return;
    const stack: Frame[] = [];
    let n = start;
    this.descend(stack, 0, M, this.initial, this.xM, n);
    for (let produced = 0; produced < count; produced++) {
      yield stack[stack.length - 1].vLo;
      if (produced + 1 === count) return;
      n++;
      while (stack.length > 0 && n > stack[stack.length - 1].hi) stack.pop();
      const top = stack.length > 0
        ? stack[stack.length - 1]
        : { lo: 0, hi: M, vLo: this.initial, vHi: this.xM };
      this.descend(stack, top.lo, top.hi, top.vLo, top.vHi, n);
    }
  }

  /** Push frames from interval [lo, hi] down to the leaf at index n. */
  private descend(stack: Frame[], lo: number, hi: number, vLo: number, vHi: number, n: number): void {
    while (hi - lo >= 2) {
      const { m, vM } = this.midpointValue(lo, hi, vLo, vHi);
      if (n <= m) {
        hi = m; vHi = vM;
      } else {
        lo = m; vLo = vM;
      }
      stack.push({ lo, hi, vLo, vHi });
    }
    const v = n === lo ? vLo : vHi;
    stack.push({ lo: n, hi: n, vLo: v, vHi: v });
    if (stack.length > this.maxIteratorDepth) this.maxIteratorDepth = stack.length;
  }
}

export function createWalk(
  seed: bigint | number,
  streamId: string,
  initial: number,
  sigma: number,
): Walk {
  return new WalkImpl(seed, streamId, initial, sigma);
}
