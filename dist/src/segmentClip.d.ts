import type { CubicSegment, ParamInterval, Vec2 } from "./types.js";
interface Edge {
    readonly ax: number;
    readonly ay: number;
    readonly dx: number;
    readonly dy: number;
    readonly len: number;
    readonly minX: number;
    readonly minY: number;
    readonly maxX: number;
    readonly maxY: number;
}
/** 预处理选区边，供一次选取中的全部段复用。 */
export interface PreparedRegion {
    readonly outer: readonly Vec2[];
    readonly holes: readonly (readonly Vec2[])[];
    readonly edges: readonly Edge[];
}
export declare function prepareRegion(outer: readonly Vec2[], holes: readonly (readonly Vec2[])[]): PreparedRegion;
/**
 * 计算单段三次贝塞尔中心线落在选区内的最大闭参数区间（局部参数 0..1）。
 *
 * 思路：曲线相对每条选区边的有向叉积是 t 的三次多项式，求根得到曲线
 * 进出选区的全部候选参数；把 [0,1] 切成原子区间/原子点后分别做
 * 点属选区判定，再把相邻的“在内”原子合并为最大闭区间。
 * 与边共线的曲线段单独处理：投影边端点到曲线参数上作为切分点，
 * 重叠部分由中点判定（边界属于选区）自然保留。
 */
export declare function clipSegmentToRegion(seg: CubicSegment, region: PreparedRegion): ParamInterval[];
export {};
