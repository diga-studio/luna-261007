import { FIELD_NAMES, type FieldName } from './types.js';

export interface FieldPostings {
  /** 长度 vocabSize + 1 */
  offsets: Uint32Array;
  /** 稠密 pageIdx */
  values: Uint32Array;
}

/** 每个字段一份 termId -> pageIdx 列表（CSR）的倒排。 */
export interface InvertedIndex {
  pageCount: number;
  pageId(pageIdx: number): number;
  /** 返回某字段某词元的倒排表（稠密 pageIdx）。 */
  postings(field: FieldName, termId: number): Uint32Array;
}

const CHUNK_SIZE = 1 << 20;

/**
 * 单字段 (termId, pageIdx) 序列的分块收集器。
 * 用定长 Uint32Array 块而非 JS 数组，避免堆膨胀与扩容抖动。
 */
export class FieldCollector {
  private termChunks: Uint32Array[] = [new Uint32Array(CHUNK_SIZE)];
  private pageChunks: Uint32Array[] = [new Uint32Array(CHUNK_SIZE)];
  private count = 0;

  add(termId: number, pageIdx: number): void {
    const slot = this.count % CHUNK_SIZE;
    if (slot === 0 && this.count > 0) {
      this.termChunks.push(new Uint32Array(CHUNK_SIZE));
      this.pageChunks.push(new Uint32Array(CHUNK_SIZE));
    }
    this.termChunks[this.termChunks.length - 1]![slot] = termId;
    this.pageChunks[this.pageChunks.length - 1]![slot] = pageIdx;
    this.count++;
  }

  /** 构建 CSR 倒排并释放收集缓冲。 */
  buildCSR(vocabSize: number): FieldPostings {
    const offsets = new Uint32Array(vocabSize + 1);
    let remaining = this.count;
    for (const chunk of this.termChunks) {
      const n = Math.min(CHUNK_SIZE, remaining);
      for (let i = 0; i < n; i++) offsets[chunk[i]! + 1]!++;
      remaining -= n;
    }
    for (let t = 0; t < vocabSize; t++) offsets[t + 1]! += offsets[t]!;

    const values = new Uint32Array(this.count);
    const cursor = Uint32Array.from(offsets.subarray(0, vocabSize));
    remaining = this.count;
    for (let c = 0; c < this.termChunks.length; c++) {
      const tChunk = this.termChunks[c]!;
      const pChunk = this.pageChunks[c]!;
      const n = Math.min(CHUNK_SIZE, remaining);
      for (let i = 0; i < n; i++) {
        const t = tChunk[i]!;
        values[cursor[t]!] = pChunk[i]!;
        cursor[t]!++;
      }
      remaining -= n;
    }
    // 释放收集缓冲
    this.termChunks = [];
    this.pageChunks = [];
    return { offsets, values };
  }
}

export function buildInvertedIndex(
  vocabSize: number,
  pageIds: number[],
  collectors: Record<FieldName, FieldCollector>,
): InvertedIndex {
  const fields = new Map<FieldName, FieldPostings>();
  for (const field of FIELD_NAMES) {
    fields.set(field, collectors[field].buildCSR(vocabSize));
  }

  const ids = Uint32Array.from(pageIds);
  return {
    pageCount: ids.length,
    pageId: (pageIdx: number) => ids[pageIdx]!,
    postings(field: FieldName, termId: number): Uint32Array {
      const fp = fields.get(field)!;
      return fp.values.subarray(fp.offsets[termId]!, fp.offsets[termId + 1]!);
    },
  };
}
