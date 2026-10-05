import type { AnalysisResult, Pair } from "../src/index.js";

/**
 * Independent reference: enumerate every matching (subset of candidate edges
 * with disjoint endpoints) that contains all rulings, keep those of maximum
 * size, and derive the expected analysis directly from the definitions.
 */
export function bruteForceAnalyze(
  transactionIds: readonly string[],
  journalIds: readonly string[],
  candidatePairs: readonly Pair[],
  rulings: readonly Pair[],
): AnalysisResult {
  const edges: [number, number][] = [];
  const seen = new Set<string>();
  for (const p of candidatePairs) {
    const key = p.transactionId + "" + p.journalId;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push([
      transactionIds.indexOf(p.transactionId),
      journalIds.indexOf(p.journalId),
    ]);
  }
  // All matchings containing every ruling, grouped by size.
  let k = -1;
  const maximal: [number, number][][] = [];
  const usedT = new Set<number>();
  const usedJ = new Set<number>();
  const chosen: [number, number][] = [];
  const rulingCount = rulings.length;

  const visit = (start: number): void => {
    if (chosen.length >= rulingCount) {
      const covered = new Set(chosen.map(([u, v]) => u + "" + v));
      let ok = true;
      for (const p of rulings) {
        const u = transactionIds.indexOf(p.transactionId);
        const v = journalIds.indexOf(p.journalId);
        if (!covered.has(u + "" + v)) { ok = false; break; }
      }
      if (ok) {
        if (chosen.length > k) {
          k = chosen.length;
          maximal.length = 0;
        }
        if (chosen.length === k) maximal.push([...chosen]);
      }
    }
    for (let i = start; i < edges.length; i++) {
      const [u, v] = edges[i]!;
      if (usedT.has(u) || usedJ.has(v)) continue;
      usedT.add(u); usedJ.add(v); chosen.push([u, v]);
      visit(i + 1);
      chosen.pop(); usedT.delete(u); usedJ.delete(v);
    }
  };
  visit(0);

  const count = new Map<string, number>();
  const coveredT = new Array<Set<number>>(maximal.length);
  const coveredJ = new Array<Set<number>>(maximal.length);
  maximal.forEach((m, idx) => {
    coveredT[idx] = new Set(m.map(([u]) => u));
    coveredJ[idx] = new Set(m.map(([, v]) => v));
    for (const [u, v] of m) {
      const key = u + "" + v;
      count.set(key, (count.get(key) ?? 0) + 1);
    }
  });

  const toPair = (key: string): Pair => {
    const [u, v] = key.split("").map(Number);
    return { transactionId: transactionIds[u!]!, journalId: journalIds[v!]! };
  };
  const certainPairs: Pair[] = [];
  const possiblePairs: Pair[] = [];
  for (const [key, c] of count) {
    possiblePairs.push(toPair(key));
    if (c === maximal.length) certainPairs.push(toPair(key));
  }
  const possiblyUnmatchedTransactionIds: string[] = [];
  const possiblyUnmatchedJournalIds: string[] = [];
  transactionIds.forEach((id, u) => {
    if (maximal.some((_, i) => !coveredT[i]!.has(u))) possiblyUnmatchedTransactionIds.push(id);
  });
  journalIds.forEach((id, v) => {
    if (maximal.some((_, i) => !coveredJ[i]!.has(v))) possiblyUnmatchedJournalIds.push(id);
  });

  return { k, certainPairs, possiblePairs, possiblyUnmatchedTransactionIds, possiblyUnmatchedJournalIds };
}

/** Whether a batch of rulings keeps some size-K matching (reference check). */
export function bruteForceFeasible(
  transactionIds: readonly string[],
  journalIds: readonly string[],
  candidatePairs: readonly Pair[],
  rulings: readonly Pair[],
): boolean {
  const usedT = new Set<string>();
  const usedJ = new Set<string>();
  const keys = new Set(candidatePairs.map((p) => p.transactionId + "" + p.journalId));
  for (const p of rulings) {
    if (!keys.has(p.transactionId + "" + p.journalId)) return false;
    if (usedT.has(p.transactionId) || usedJ.has(p.journalId)) return false;
    usedT.add(p.transactionId);
    usedJ.add(p.journalId);
  }
  const full = bruteForceAnalyze(transactionIds, journalIds, candidatePairs, []);
  const withRulings = bruteForceAnalyze(transactionIds, journalIds, candidatePairs, rulings);
  return withRulings.k === full.k;
}
