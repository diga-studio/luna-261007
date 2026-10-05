import { normalizeText, normalizeWithMap } from "./normalize.js";
import { findHits, type NormalizedEntry } from "./matcher.js";
import { WordStore } from "./store.js";
import type { MatchHit, WordEntry } from "./types.js";

export type { MatchHit, WordEntry } from "./types.js";
export { normalizeText } from "./normalize.js";

/** 敏感词审核库入口：由评价收集和人工审核模块直接调用 */
export class SensitiveWordReview {
  private readonly store: WordStore;

  constructor(dbPath: string) {
    this.store = new WordStore(dbPath);
  }

  /** 全量替换词表；提交成功后重新打开库仍可使用 */
  replaceEntries(entries: WordEntry[]): void {
    this.store.replaceAll(entries);
  }

  /** 读取当前词表 */
  listEntries(): WordEntry[] {
    return this.store.getAll();
  }

  /** 检查一条评价，返回全部命中（含重叠），区间为原文 UTF-16 代码单元 [start, end) */
  check(text: string): MatchHit[] {
    const entries: NormalizedEntry[] = this.store
      .getAll()
      .map((entry) => ({ id: entry.id, normalized: normalizeText(entry.text) }));
    return findHits(normalizeWithMap(text), entries);
  }

  close(): void {
    this.store.close();
  }
}
