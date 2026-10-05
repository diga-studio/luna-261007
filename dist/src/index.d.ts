import type { MatchHit, WordEntry } from "./types.js";
export type { MatchHit, WordEntry } from "./types.js";
export { normalizeText } from "./normalize.js";
/** 敏感词审核库入口：由评价收集和人工审核模块直接调用 */
export declare class SensitiveWordReview {
    private readonly store;
    constructor(dbPath: string);
    /** 全量替换词表；提交成功后重新打开库仍可使用 */
    replaceEntries(entries: WordEntry[]): void;
    /** 读取当前词表 */
    listEntries(): WordEntry[];
    /** 检查一条评价，返回全部命中（含重叠），区间为原文 UTF-16 代码单元 [start, end) */
    check(text: string): MatchHit[];
    close(): void;
}
