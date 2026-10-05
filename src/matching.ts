/**
 * Maximum-weight bipartite matching (Hungarian algorithm).
 * Returns an array `match` of length nRows where match[i] is the matched
 * column index, or -1 when the row is left unmatched.
 * Weights may be NEG_INF for forbidden pairs; every row must be matchable
 * to at least one column (callers add zero-weight dummy columns).
 */
export const NEG_INF = -1e15;

export function maxWeightMatching(weights: number[][]): number[] {
  const n = weights.length;
  const firstRow = weights[0];
  const m = firstRow === undefined ? 0 : firstRow.length;
  if (n === 0 || m === 0) {
    return new Array<number>(n).fill(-1);
  }
  if (n > m) {
    throw new Error("maxWeightMatching requires rows <= columns");
  }
  // 1-indexed Hungarian algorithm, maximizes total weight.
  const u = new Array<number>(n + 1).fill(0);
  const v = new Array<number>(m + 1).fill(0);
  const p = new Array<number>(m + 1).fill(0);
  const way = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array<number>(m + 1).fill(Infinity);
    const used = new Array<boolean>(m + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0] as number;
      const row = weights[i0 - 1] as number[];
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cur = -(row[j - 1] as number) - (u[i0] as number) - (v[j] as number);
        if (cur < (minv[j] as number)) {
          minv[j] = cur;
          way[j] = j0;
        }
        if ((minv[j] as number) < delta) {
          delta = minv[j] as number;
          j1 = j;
        }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) {
          u[p[j] as number] = (u[p[j] as number] as number) + delta;
          v[j] = (v[j] as number) - delta;
        } else {
          minv[j] = (minv[j] as number) - delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0] as number;
      p[j0] = p[j1] as number;
      j0 = j1;
    } while (j0 !== 0);
  }
  const match = new Array<number>(n).fill(-1);
  for (let j = 1; j <= m; j++) {
    const i = p[j] as number;
    if (i > 0) match[i - 1] = j - 1;
  }
  return match;
}
