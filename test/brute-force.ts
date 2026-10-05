import type { AnalysisResult, Pair } from "../src/index.js";

function conflicts(a: Pair, b: Pair): boolean {
  return a.transactionId === b.transactionId || a.journalId === b.journalId;
}

/** Enumerates every matching (set of non-conflicting pairs) containing `forced`. */
export function enumerateMatchings(
  candidatePairs: readonly Pair[],
  forced: readonly Pair[]
): Pair[][] {
  for (let i = 0; i < forced.length; i += 1) {
    for (let j = i + 1; j < forced.length; j += 1) {
      if (conflicts(forced[i], forced[j])) return [];
    }
  }
  const results: Pair[][] = [];
  const current: Pair[] = [...forced];
  const walk = (index: number): void => {
    results.push([...current]);
    for (let i = index; i < candidatePairs.length; i += 1) {
      const pair = candidatePairs[i];
      if (current.some((p) => conflicts(p, pair))) continue;
      current.push(pair);
      walk(i + 1);
      current.pop();
    }
  };
  walk(0);
  return results;
}

/** Reference analysis: derives every output by exhaustive enumeration. */
export function bruteForceAnalyze(
  transactionIds: readonly string[],
  journalIds: readonly string[],
  candidatePairs: readonly Pair[],
  acceptedPairs: readonly Pair[]
): AnalysisResult {
  const matchings = enumerateMatchings(candidatePairs, [...acceptedPairs]);
  const k = Math.max(...matchings.map((m) => m.length));
  const optimal = matchings.filter((m) => m.length === k);

  const has = (m: Pair[], pair: Pair): boolean =>
    m.some((p) => p.transactionId === pair.transactionId && p.journalId === pair.journalId);

  const possiblePairs = candidatePairs.filter((pair) =>
    optimal.some((m) => has(m, pair))
  );
  const certainPairs = candidatePairs.filter((pair) =>
    optimal.every((m) => has(m, pair))
  );
  const matchedTransactions = (m: Pair[]): Set<string> =>
    new Set(m.map((p) => p.transactionId));
  const matchedJournals = (m: Pair[]): Set<string> =>
    new Set(m.map((p) => p.journalId));

  return {
    k,
    certainPairs,
    possiblePairs,
    possiblyUnmatchedTransactionIds: transactionIds.filter((id) =>
      optimal.some((m) => !matchedTransactions(m).has(id))
    ),
    possiblyUnmatchedJournalIds: journalIds.filter((id) =>
      optimal.some((m) => !matchedJournals(m).has(id))
    ),
  };
}

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
