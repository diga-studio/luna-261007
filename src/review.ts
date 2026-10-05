import { readFileSync } from "node:fs";
import { Automaton } from "./automaton.js";
import { analyzeText, normalizeWord, normalizedCodePoints } from "./normalize.js";
import type { Hit, LexiconEntry, ReviewResult } from "./types.js";

/** 单次待审文本大小上限：4 MiB（按 UTF-8 编码计算）。 */
export const MAX_TEXT_BYTES = 4 * 1024 * 1024;

/**
 * 关键词审核器：载入词库后可反复审核单个字段。
 * 词库载入后在审核期间保持不变；待审文本与审核结果不持久化。
 */
export class KeywordReviewer {
  private readonly automaton: Automaton;
  /** patternIds[p]：归一化词 p 对应的所有词库编号（等价词分属不同审核依据）。 */
  private readonly patternIds: readonly (readonly number[])[];
  /** 可复用的位置映射缓冲区，避免每次审核分配大数组。 */
  private mapBuffer: Uint32Array | undefined;

  private constructor(automaton: Automaton, patternIds: readonly (readonly number[])[]) {
    this.automaton = automaton;
    this.patternIds = patternIds;
  }

  /** 从本地 JSON 文件载入词库（数组，元素为 { id, word }）。 */
  static loadFromFile(path: string): KeywordReviewer {
    const raw = readFileSync(path, "utf8");
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data)) {
      throw new Error("lexicon file must contain a JSON array of { id, word }");
    }
    return KeywordReviewer.fromEntries(data as readonly LexiconEntry[]);
  }

  /** 直接由词库项构建（词库项按等价规则处理后必须非空）。 */
  static fromEntries(entries: readonly LexiconEntry[]): KeywordReviewer {
    const wordToPattern = new Map<string, number>();
    const patterns: string[] = [];
    const patternIds: number[][] = [];
    for (const entry of entries) {
      if (typeof entry?.id !== "number" || !Number.isFinite(entry.id)) {
        throw new Error("lexicon entry id must be a finite number");
      }
      if (typeof entry.word !== "string") {
        throw new Error("lexicon entry word must be a string");
      }
      const normalized = normalizeWord(entry.word);
      if (normalized.length === 0) {
        throw new Error(`lexicon entry ${entry.id} is empty after normalization`);
      }
      let p = wordToPattern.get(normalized);
      if (p === undefined) {
        p = patterns.length;
        wordToPattern.set(normalized, p);
        patterns.push(normalized);
        patternIds.push([]);
      }
      patternIds[p]!.push(entry.id);
    }
    return new KeywordReviewer(new Automaton(patterns), patternIds);
  }

  /** 审核单个字段的纯文本，返回是否拦截及各编号的最早命中范围。 */
  review(text: string): ReviewResult {
    const { utf8Bytes, needsMap } = analyzeText(text);
    if (utf8Bytes > MAX_TEXT_BYTES) {
      throw new Error(`text exceeds ${MAX_TEXT_BYTES} bytes (UTF-8)`);
    }
    const hitsById = new Map<number, Hit>();
    if (!needsMap) {
      // 恒等映射快路径：归一化码点下标即原文 UTF-16 下标，零分配
      this.automaton.scan(text, (patternIndex, start, end) => {
        for (const id of this.patternIds[patternIndex]!) {
          if (!hitsById.has(id)) {
            hitsById.set(id, { id, start, end });
          }
        }
      });
    } else {
      // 流式归一化：位置映射随扫描写入可复用缓冲区，不分配归一化字符串
      if (this.mapBuffer === undefined || this.mapBuffer.length < text.length) {
        this.mapBuffer = new Uint32Array(text.length);
      }
      const map = this.mapBuffer;
      this.automaton.scan(normalizedCodePoints(text, map), (patternIndex, start, end) => {
        const firstOrig = map[start]!;
        const lastOrig = map[end - 1]!;
        const lastCp = text.codePointAt(lastOrig)!;
        const origEnd = lastOrig + (lastCp > 0xffff ? 2 : 1);
        for (const id of this.patternIds[patternIndex]!) {
          if (!hitsById.has(id)) {
            hitsById.set(id, { id, start: firstOrig, end: origEnd });
          }
        }
      });
    }
    const hits = [...hitsById.values()].sort((a, b) => a.id - b.id);
    return { blocked: hits.length > 0, hits };
  }
}
