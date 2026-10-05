import type { MatchHit } from "./types.js";
import type { NormalizedText } from "./normalize.js";

/**
 * 在标准化文本中查找一个标准化词条的全部连续子串命中（含相互重叠），
 * 并映射回原文 UTF-16 区间：
 * - 命中涉及的每个标准化单元都属于某个字素簇，区间取这些字素簇
 *   在原文中的最左起点至最右终点（完整覆盖参与命中的字素簇）；
 * - 同一词条落在同一原文区间的多次命中只报告一次；
 * - 标准化后为空的词条不产生命中。
 */
export function findHits(
  entryId: number,
  normalizedWord: string,
  target: NormalizedText,
): MatchHit[] {
  if (normalizedWord.length === 0) return [];

  const hits: MatchHit[] = [];
  const seen = new Set<string>();
  const { normalized, normalizedToOrigin } = target;

  let from = 0;
  for (;;) {
    const at = normalized.indexOf(normalizedWord, from);
    if (at === -1) break;
    const last = at + normalizedWord.length - 1;
    const start = normalizedToOrigin[at].start;
    const end = normalizedToOrigin[last].end;
    const key = `${start}:${end}`;
    if (!seen.has(key)) {
      seen.add(key);
      hits.push({ id: entryId, start, end });
    }
    from = at + 1; // 允许重叠命中
  }
  return hits;
}
