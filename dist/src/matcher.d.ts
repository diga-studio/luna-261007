import type { MatchHit } from "./types.js";
import type { NormalizedText } from "./normalize.js";
export interface NormalizedEntry {
    id: number;
    normalized: string;
}
/** 在标准化后的评价上按连续子串找出全部命中（含重叠），并映射回原文区间 */
export declare function findHits(review: NormalizedText, entries: NormalizedEntry[]): MatchHit[];
