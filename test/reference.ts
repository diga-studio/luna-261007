import { FIELD_WEIGHT, type Hit, type Page, type SynonymEdge } from "../src/types.js";

/** Levenshtein distance over Unicode code points, insert/delete/substitute only. */
export function editDistance(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  let prev = new Array<number>(y.length + 1);
  let curr = new Array<number>(y.length + 1);
  for (let j = 0; j <= y.length; j++) prev[j] = j;
  for (let i = 1; i <= x.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= y.length; j++) {
      curr[j] = Math.min(
        prev[j]! + 1,
        curr[j - 1]! + 1,
        prev[j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1),
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[y.length]!;
}

function expandReference(
  starts: ReadonlyMap<string, number>,
  edges: readonly SynonymEdge[],
): Map<string, number> {
  const best = new Map<string, number>();
  for (const [w, c] of starts) if (c > 0) best.set(w, c);
  // Relax to fixpoint (independent of the heap-based implementation).
  let changed = true;
  while (changed) {
    changed = false;
    for (const e of edges) {
      const c = best.get(e.from);
      if (c === undefined) continue;
      const next = Math.floor((c * e.w) / 1000);
      if (next > 0 && next > (best.get(e.to) ?? 0)) {
        best.set(e.to, next);
        changed = true;
      }
    }
  }
  return best;
}

/**
 * Independent brute-force reference implementation used only by tests.
 * Correct by construction, slow by design.
 */
export function referenceSearch(
  pages: readonly Page[],
  synonyms: readonly SynonymEdge[],
  query: readonly string[],
  k: number,
): Hit[] {
  const vocab = new Set<string>();
  for (const p of pages) {
    for (const t of [...p.title, ...p.body, ...p.tags, ...p.author]) vocab.add(t);
  }
  for (const e of synonyms) {
    vocab.add(e.from);
    vocab.add(e.to);
  }
  const words = [...vocab];

  const terms = [...new Set(query)];
  let survivors: Set<number> | null = null;
  const totals = new Map<number, number>();
  for (const term of terms) {
    const starts = new Map<string, number>();
    starts.set(term, 1000);
    for (const w of words) {
      if (w !== term && editDistance(term, w) === 1) starts.set(w, 600);
    }
    const expanded = expandReference(starts, synonyms);
    const termScores = new Map<number, number>();
    for (const p of pages) {
      let contribution = 0;
      const fields = [p.title, p.tags, p.author, p.body];
      for (const [word, conf] of expanded) {
        for (let f = 0; f < 4; f++) {
          if (fields[f]!.includes(word)) {
            contribution = Math.max(contribution, conf * FIELD_WEIGHT[f]!);
          }
        }
      }
      if (contribution > 0) termScores.set(p.id, contribution);
    }
    if (survivors === null) {
      survivors = new Set(termScores.keys());
    } else {
      for (const pid of [...survivors]) {
        if (!termScores.has(pid)) survivors.delete(pid);
      }
    }
    for (const pid of survivors) {
      totals.set(pid, (totals.get(pid) ?? 0) + termScores.get(pid)!);
    }
  }
  return [...(survivors ?? new Set<number>())]
    .map((id) => ({ id, score: totals.get(id)! }))
    .sort((a, b) => b.score - a.score || a.id - b.id)
    .slice(0, k);
}
