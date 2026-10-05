/** 词条：独立编号 + 词条原文 */
export interface WordEntry {
  id: number;
  text: string;
}

/** 一次命中：词条编号 + 原文 UTF-16 区间（起点包含、终点不包含） */
export interface MatchHit {
  id: number;
  start: number;
  end: number;
}
