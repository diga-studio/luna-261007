import {
  EXACT_CONFIDENCE,
  FIELD_NAMES,
  FIELD_WEIGHTS,
  TYPO_CONFIDENCE,
  type Page,
  type SearchResult,
  type SynonymEdge,
} from '../src/types.js';

/** 全量 DP 编辑距离（码点级），仅用于测试参考实现。 */
export function editDistance(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  const m = x.length;
  const n = y.length;
  let prev = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    const cur = new Array<number>(n + 1);
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[n]!;
}

/** 暴力多跳扩展：反复松弛直到不动点（小数据专用）。 */
export function referenceExpand(
  starts: Map<string, number>,
  edges: SynonymEdge[],
): Map<string, number> {
  const best = new Map<string, number>();
  for (const [t, c] of starts) {
    if (c > (best.get(t) ?? 0)) best.set(t, c);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const e of edges) {
      const conf = best.get(e.from);
      if (conf === undefined) continue;
      const nconf = Math.floor((conf * e.w) / 1000);
      if (nconf > 0 && nconf > (best.get(e.to) ?? 0)) {
        best.set(e.to, nconf);
        changed = true;
      }
    }
  }
  for (const [t, c] of best) {
    if (c <= 0) best.delete(t);
  }
  return best;
}

/** 独立全量参考计算：扫描全词表、全语料。 */
export function referenceSearch(
  pages: Page[],
  synonyms: SynonymEdge[],
  query: string[],
  k: number,
): SearchResult[] {
  const vocab = new Set<string>();
  for (const p of pages) {
    for (const f of FIELD_NAMES) for (const t of p[f]) vocab.add(t);
  }
  for (const e of synonyms) {
    vocab.add(e.from);
    vocab.add(e.to);
  }

  const qterms = [...new Set(query)];
  const expansions: Map<string, number>[] = qterms.map((q) => {
    const starts = new Map<string, number>();
    if (vocab.has(q)) starts.set(q, EXACT_CONFIDENCE);
    for (const w of vocab) {
      if (editDistance(q, w) === 1) starts.set(w, TYPO_CONFIDENCE);
    }
    return referenceExpand(starts, synonyms);
  });

  const results: SearchResult[] = [];
  for (const page of pages) {
    let total = 0;
    let hitAll = true;
    for (const expanded of expansions) {
      let contrib = 0;
      for (const [term, conf] of expanded) {
        for (const f of FIELD_NAMES) {
          if (page[f].includes(term)) {
            const score = conf * FIELD_WEIGHTS[f];
            if (score > contrib) contrib = score;
          }
        }
      }
      if (contrib === 0) {
        hitAll = false;
        break;
      }
      total += contrib;
    }
    if (hitAll) results.push({ id: page.id, score: total });
  }
  results.sort((a, b) => b.score - a.score || a.id - b.id);
  return results.slice(0, k);
}
