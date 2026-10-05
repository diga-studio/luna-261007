export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      const del = prev[j] + 1;
      const ins = curr[j - 1] + 1;
      const sub = prev[j - 1] + cost;
      curr[j] = del < ins ? (del < sub ? del : sub) : ins < sub ? ins : sub;
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[n];
}

/**
 * Returns the exact Levenshtein distance when it is <= k, otherwise returns
 * some value > k (early exit). Only insertions, deletions and substitutions
 * are allowed, each at unit cost.
 */
export function boundedLevenshtein(a: string, b: string, k: number): number {
  if (k < 0) return 1;
  let s = a;
  let t = b;
  if (s.length > t.length) {
    const tmp = s;
    s = t;
    t = tmp;
  }
  const m = s.length;
  const n = t.length;
  if (n - m > k) return k + 1;
  if (m === 0) return n;

  const INF = k + 1;
  // Band: columns [lo, hi] around the diagonal; anything outside exceeds k.
  let prev = new Array<number>(n + 1).fill(INF);
  let curr = new Array<number>(n + 1).fill(INF);
  const hi0 = Math.min(n, k);
  for (let j = 0; j <= hi0; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    const lo = Math.max(1, i - k);
    const hi = Math.min(n, i + k);
    if (lo > hi) return INF;
    curr.fill(INF, 0, lo);
    curr[lo - 1] = INF;
    if (lo === 1) curr[0] = i <= k ? i : INF;
    const ca = s.charCodeAt(i - 1);
    let rowMin = INF;
    for (let j = lo; j <= hi; j++) {
      const cost = ca === t.charCodeAt(j - 1) ? 0 : 1;
      const del = prev[j] + 1;
      const ins = curr[j - 1] + 1;
      const sub = prev[j - 1] + cost;
      const v = del < ins ? (del < sub ? del : sub) : ins < sub ? ins : sub;
      curr[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (hi < n) curr[hi + 1] = INF;
    if (rowMin > k) return INF;
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[n];
}

export function similarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  const d = levenshtein(a, b);
  return 1 - d / maxLen;
}
