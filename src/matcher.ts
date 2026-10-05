import type { MatchHit } from "./types.js";
import type { NormalizedText } from "./normalize.js";

export interface NormalizedEntry {
  id: number;
  normalized: string;
}

/** 在标准化后的评价上按连续子串找出全部命中（含重叠），并映射回原文区间 */
export function findHits(review: NormalizedText, entries: NormalizedEntry[]): MatchHit[] {
  const hits: MatchHit[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    if (entry.normalized.length === 0) {
      continue; // 标准化后为空的词条不产生命中
    }
    let from = 0;
    while (from <= review.text.length - entry.normalized.length) {
      const at = review.text.indexOf(entry.normalized, from);
      if (at === -1) {
        break;
      }
      from = at + 1; // 步进 1，保证重叠命中不遗漏
      const normStart = at;
      const normEnd = at + entry.normalized.length;

      // 覆盖与命中区间相交的全部字素簇，区间取最左起点至最右终点
      let srcStart = -1;
      let srcEnd = -1;
      for (const cluster of review.clusters) {
        if (cluster.normStart < normEnd && cluster.normEnd > normStart) {
          if (srcStart === -1 || cluster.srcStart < srcStart) {
            srcStart = cluster.srcStart;
          }
          if (cluster.srcEnd > srcEnd) {
            srcEnd = cluster.srcEnd;
          }
        }
      }
      if (srcStart === -1) {
        continue;
      }

      // 同一词条落在同一原文区间的多次命中只报告一次
      const key = `${entry.id}:${srcStart}:${srcEnd}`;
      if (!seen.has(key)) {
        seen.add(key);
        hits.push({ entryId: entry.id, start: srcStart, end: srcEnd });
      }
    }
  }

  hits.sort((a, b) => a.start - b.start || a.end - b.end || a.entryId - b.entryId);
  return hits;
}
