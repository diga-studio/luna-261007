/** 二维点，坐标单位英尺，float64。 */
export interface Vec2 {
    readonly x: number;
    readonly y: number;
}
/** 三次贝塞尔段：四个控制点。 */
export interface CubicSegment {
    readonly p0: Vec2;
    readonly p1: Vec2;
    readonly p2: Vec2;
    readonly p3: Vec2;
}
/** 样条：唯一 ID + 首尾相接的三次贝塞尔段序列。 */
export interface Spline {
    readonly id: string;
    readonly segments: readonly CubicSegment[];
}
/**
 * 选区：一个简单多边形外环 + 零个或多个孔洞。
 * 环为顶点序列（首尾顶点不重复列出），顺逆时针均可。
 * 选区 = 外环内部（含边界）减去孔洞内部（孔洞边界仍属选区）。
 */
export interface SelectionRegion {
    readonly outer: readonly Vec2[];
    readonly holes: readonly Vec2[][];
}
/** 选取方式。 */
export type SelectorMode = "intersect" | "contain";
/**
 * 命中样条中心线落在选区内的最大闭参数区间。
 * 第 i 段对应全局参数 [i, i+1]。
 */
export interface ParamInterval {
    readonly start: number;
    readonly end: number;
}
/** 单条命中样条的结果。 */
export interface SplineHit {
    readonly id: string;
    /** 按参数递增、已合并的最大闭区间；允许 start === end 的孤立接触点。 */
    readonly intervals: ParamInterval[];
}
