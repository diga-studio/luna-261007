import type { ArticleInput, CategoryId } from "../src/index.js";

/**
 * 标准结果：按当前分类树与文章状态逐篇重新计算每个分类的覆盖计数。
 * 刻意用与库实现不同的朴素方式计算，作为对照。
 */
export function computeExpectedCounts(
  parents: ReadonlyMap<CategoryId, CategoryId | null>,
  articles: readonly ArticleInput[],
): Map<CategoryId, number> {
  const result = new Map<CategoryId, number>();
  for (const categoryId of parents.keys()) {
    const scope = new Set<CategoryId>([categoryId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const [child, parent] of parents) {
        if (parent !== null && scope.has(parent) && !scope.has(child)) {
          scope.add(child);
          grew = true;
        }
      }
    }
    let count = 0;
    for (const article of articles) {
      if (!article.published) continue;
      if (article.categoryIds.some((id) => scope.has(id))) count++;
    }
    result.set(categoryId, count);
  }
  return result;
}

/** 确定性伪随机数（mulberry32），保证测试可复现。 */
export function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
