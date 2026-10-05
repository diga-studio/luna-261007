const MIN_LEN = 8;
const MAX_LEN = 32;

function thresholdFor(maxLen: number): number {
  return Math.floor(maxLen / 10);
}

/**
 * A pair of strings with lengths (l1, l2) can satisfy 10*d <= max(l1, l2)
 * with d >= 1 only when the length gap fits the threshold. Pairs with
 * threshold 0 are exact-match only and handled by value grouping.
 */
function viablePair(l1: number, l2: number): boolean {
  const k = thresholdFor(Math.max(l1, l2));
  return k >= 1 && Math.abs(l1 - l2) <= k;
}

/**
 * Pigeonhole run bound: if d(s, t) <= k and n = min(|s|, |t|), the shorter
 * string is split by at most k edited positions into at most k+1 exact-match
 * runs, so s and t share a common substring of length >= ceil((n-k)/(k+1)),
 * and therefore share every g-gram with g <= that bound.
 */
function runBound(n: number, m: number): number {
  const k = thresholdFor(Math.max(n, m));
  return Math.ceil((Math.min(n, m) - k) / (k + 1));
}

const gramLengthTable: number[] = (() => {
  const table = new Array<number>(MAX_LEN + 1).fill(0);
  for (let len = MIN_LEN; len <= MAX_LEN; len++) {
    let g = 0;
    for (let other = MIN_LEN; other <= MAX_LEN; other++) {
      if (!viablePair(len, other)) continue;
      const r = runBound(len, other);
      if (g === 0 || r < g) g = r;
    }
    table[len] = g;
  }
  return table;
})();

/**
 * Gram length used when indexing a string of the given length. Any pair
 * meeting the similarity threshold is guaranteed to share at least one gram
 * of this length. Returns 0 when only exact matches are possible.
 */
export function gramLengthFor(len: number): number {
  if (len < MIN_LEN || len > MAX_LEN) return 0;
  return gramLengthTable[len];
}

function* gramsOf(value: string, g: number): Generator<string> {
  for (let i = 0; i + g <= value.length; i++) {
    yield value.substring(i, i + g);
  }
}

/**
 * Inverted index from g-grams to the slots of the distinct values that
 * contain them. Each value is indexed under the single gram length
 * gramLengthFor(value.length); lookups probe every gram length that a
 * viable partner length could require, so no matching pair is ever missed.
 */
export class GramIndex {
  private readonly buckets = new Map<number, Map<string, number[]>>();

  add(value: string, slot: number): void {
    const g = gramLengthFor(value.length);
    if (g <= 0 || g > value.length) return;
    let byGram = this.buckets.get(g);
    if (byGram === undefined) {
      byGram = new Map<string, number[]>();
      this.buckets.set(g, byGram);
    }
    for (const gram of gramsOf(value, g)) {
      const list = byGram.get(gram);
      if (list === undefined) {
        byGram.set(gram, [slot]);
      } else if (list[list.length - 1] !== slot) {
        list.push(slot);
      }
    }
  }

  /**
   * Returns the slots of every indexed value that shares at least one
   * relevant gram with `value`. This is a superset of the values whose
   * similarity to `value` reaches the threshold (exact filter, no
   * approximate recall).
   */
  candidates(value: string): number[] {
    const len = value.length;
    const seen = new Set<number>();
    const out: number[] = [];
    for (let other = MIN_LEN; other <= MAX_LEN; other++) {
      if (!viablePair(len, other)) continue;
      const g = gramLengthFor(other);
      if (g <= 0 || g > len) continue;
      const byGram = this.buckets.get(g);
      if (byGram === undefined) continue;
      for (const gram of gramsOf(value, g)) {
        const list = byGram.get(gram);
        if (list === undefined) continue;
        for (const slot of list) {
          if (!seen.has(slot)) {
            seen.add(slot);
            out.push(slot);
          }
        }
      }
    }
    return out;
  }
}
