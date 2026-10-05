/** 词条：独立编号 + 词条原文 */
export interface WordEntry {
    id: number;
    text: string;
}
/** 一次命中：词条编号 + 原文区间（UTF-16 代码单元，起点包含、终点不包含） */
export interface MatchHit {
    entryId: number;
    start: number;
    end: number;
}
