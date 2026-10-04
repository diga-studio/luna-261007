const PADDING_VALUE = 0xffffffff;

/**
 * Merge sort tree over latencies ordered by timestamp.
 *
 * Leaves are the latency values in timestamp order, padded to a power of two.
 * Each internal level stores, per node, the sorted merge of its two children.
 * Supports exact "count of values <= v" and "k-th smallest value" over any
 * contiguous leaf index range in O(log^2 N) time.
 */
export class MergeSortTree {
  /** Number of real (non-padding) elements. */
  readonly size: number;

  readonly #levels: Uint32Array[];
  readonly #maxValue: number;

  constructor(valuesInTimeOrder: Uint32Array, maxValue: number) {
    this.size = valuesInTimeOrder.length;
    this.#maxValue = maxValue;

    let leafCount = 1;
    while (leafCount < this.size) leafCount <<= 1;

    const levels: Uint32Array[] = new Array<Uint32Array>();
    const leaves = new Uint32Array(leafCount);
    leaves.fill(PADDING_VALUE);
    leaves.set(valuesInTimeOrder);
    levels.push(leaves);

    let runLength = 1;
    while (runLength < leafCount) {
      const previous = levels[levels.length - 1];
      const merged = new Uint32Array(leafCount);
      const childLength = runLength;
      const nodeLength = runLength << 1;
      for (let start = 0; start < leafCount; start += nodeLength) {
        const mid = start + childLength;
        const end = start + nodeLength;
        let left = start;
        let right = mid;
        let out = start;
        while (left < mid && right < end) {
          if (previous[left] <= previous[right]) {
            merged[out++] = previous[left++];
          } else {
            merged[out++] = previous[right++];
          }
        }
        while (left < mid) merged[out++] = previous[left++];
        while (right < end) merged[out++] = previous[right++];
      }
      levels.push(merged);
      runLength = nodeLength;
    }
    this.#levels = levels;
  }

  /** Count elements with value <= v in leaf index range [from, to). */
  countLessOrEqual(from: number, to: number, v: number): number {
    let a = from;
    let b = to;
    let total = 0;
    let runLength = 1;
    for (let level = 0; a < b; level++, runLength <<= 1) {
      if (a & 1) {
        total += upperBound(this.#levels[level], a * runLength, runLength, v);
        a++;
      }
      if (b & 1) {
        b--;
        total += upperBound(this.#levels[level], b * runLength, runLength, v);
      }
      a >>= 1;
      b >>= 1;
    }
    return total;
  }

  /**
   * Smallest value v such that countLessOrEqual(from, to, v) >= k.
   * k is 1-based and must satisfy 1 <= k <= to - from.
   */
  kthSmallest(from: number, to: number, k: number): number {
    let lo = -1; // countLessOrEqual(lo) < k always (values are >= 0)
    let hi = this.#maxValue; // countLessOrEqual(hi) >= k always
    while (hi - lo > 1) {
      const mid = (lo + hi) >>> 1;
      if (this.countLessOrEqual(from, to, mid) >= k) {
        hi = mid;
      } else {
        lo = mid;
      }
    }
    return hi;
  }
}

/** Number of values <= v in data[start, start + length); data segment is sorted. */
function upperBound(data: Uint32Array, start: number, length: number, v: number): number {
  let lo = start;
  let hi = start + length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (data[mid] <= v) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo - start;
}
