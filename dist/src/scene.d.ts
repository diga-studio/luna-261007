import type { ParamInterval, SelectionRegion, SelectorMode, Spline, SplineHit } from "./types.js";
/** 进程内存中的样条场景，由上层画布批量装入并执行区域选取。 */
export declare class SplineScene {
    private splines;
    /** 批量装入样条，替换原有场景内容。 */
    loadSplines(splines: readonly Spline[]): void;
    /**
     * 按选区选取样条。
     * - intersect：样条上至少一个点属于选区（含孤立接触点）。
     * - contain：样条上所有点都属于选区（区间覆盖完整参数域 [0, 段数]）。
     */
    select(region: SelectionRegion, mode: SelectorMode): SplineHit[];
}
export type { ParamInterval, SelectionRegion, SelectorMode, Spline, SplineHit };
