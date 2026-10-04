function popcount32(x: number): number {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0f0f0f0f;
  return Math.imul(x, 0x01010101) >>> 24;
}

/** Number of 1-bits in `bits` at positions [0, i). */
function rank1(bits: Uint32Array, prefix: Uint32Array, i: number): number {
  const block = i >>> 5;
  return prefix[block]! + popcount32(bits[block]! & ((1 << (i & 31)) - 1));
}

/**
 * Wavelet matrix over unsigned integer values. Supports exact
 * kth-smallest selection over the union of multiple index ranges in
 * O(levels * rangeCount) time. Latencies are stored in the order of the
 * backing array; ranges refer to positions in that array.
 */
export class WaveletMatrix {
  private readonly levels: number;
  private readonly bits: Uint32Array[];
  private readonly prefix: Uint32Array[];
  private readonly zeros: Uint32Array;

  constructor(values: Uint32Array, levels: number) {
    if (!Number.isInteger(levels) || levels < 1 || levels > 31) {
      throw new RangeError('levels must be an integer in [1, 31]');
    }
    this.levels = levels;
    const n = values.length;
    const numBlocks = (n + 31) >>> 5;
    this.bits = [];
    this.prefix = [];
    this.zeros = new Uint32Array(levels);

    let current = Uint32Array.from(values);
    let next = new Uint32Array(n);
    for (let depth = 0; depth < levels; depth++) {
      const shift = levels - 1 - depth;
      const bits = new Uint32Array(numBlocks);
      let zeroCount = 0;
      for (let i = 0; i < n; i++) {
        if (((current[i]! >>> shift) & 1) === 0) zeroCount += 1;
      }
      let zeroPos = 0;
      let onePos = zeroCount;
      for (let i = 0; i < n; i++) {
        const value = current[i]!;
        if (((value >>> shift) & 1) === 0) {
          next[zeroPos] = value;
          zeroPos += 1;
        } else {
          next[onePos] = value;
          onePos += 1;
          bits[i >>> 5] = bits[i >>> 5]! | (1 << (i & 31));
        }
      }
      const prefix = new Uint32Array(numBlocks + 1);
      let sum = 0;
      for (let block = 0; block < numBlocks; block++) {
        prefix[block] = sum;
        sum += popcount32(bits[block]!);
      }
      prefix[numBlocks] = sum;
      this.bits.push(bits);
      this.prefix.push(prefix);
      this.zeros[depth] = zeroCount;
      const swap = current;
      current = next;
      next = swap;
    }
  }

  /**
   * Returns the kth smallest value (0-indexed) in the union of the given
   * half-open index ranges. `ranges` is a flat [l0, r0, l1, r1, ...]
   * array with `rangeCount` entries; ranges must not overlap.
   */
  kthInRanges(ranges: Uint32Array, rangeCount: number, k: number): number {
    const ls = new Uint32Array(rangeCount);
    const rs = new Uint32Array(rangeCount);
    let total = 0;
    for (let i = 0; i < rangeCount; i++) {
      ls[i] = ranges[2 * i]!;
      rs[i] = ranges[2 * i + 1]!;
      total += rs[i]! - ls[i]!;
    }
    if (k < 0 || k >= total) {
      throw new RangeError(`k=${k} out of bounds for ${total} elements`);
    }

    const l1s = new Uint32Array(rangeCount);
    const r1s = new Uint32Array(rangeCount);
    let result = 0;
    for (let depth = 0; depth < this.levels; depth++) {
      const bits = this.bits[depth]!;
      const prefix = this.prefix[depth]!;
      let zeroTotal = 0;
      for (let i = 0; i < rangeCount; i++) {
        const l = ls[i]!;
        const r = rs[i]!;
        const l1 = rank1(bits, prefix, l);
        const r1 = rank1(bits, prefix, r);
        l1s[i] = l1;
        r1s[i] = r1;
        zeroTotal += r - l - (r1 - l1);
      }
      if (k < zeroTotal) {
        for (let i = 0; i < rangeCount; i++) {
          ls[i] = ls[i]! - l1s[i]!;
          rs[i] = rs[i]! - r1s[i]!;
        }
      } else {
        k -= zeroTotal;
        result |= 1 << (this.levels - 1 - depth);
        const zeros = this.zeros[depth]!;
        for (let i = 0; i < rangeCount; i++) {
          ls[i] = zeros + l1s[i]!;
          rs[i] = zeros + r1s[i]!;
        }
      }
    }
    return result;
  }
}
