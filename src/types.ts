/** 词库中的一项：稳定编号 + 词语。 */
export interface LexiconEntry {
  readonly id: number;
  readonly word: string;
}

/** 一处命中：词库编号 + 原文 UTF-16 码元范围（左闭右开，从 0 开始）。 */
export interface Hit {
  readonly id: number;
  readonly start: number;
  readonly end: number;
}

/** 审核结果。有任何命中即拦截。 */
export interface ReviewResult {
  readonly blocked: boolean;
  readonly hits: readonly Hit[];
}
