/** 二维点，float64，单位英尺。 */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/** 三次贝塞尔段：四个控制点。 */
export interface CubicBezierSegment {
  readonly p0: Point;
  readonly p1: Point;
  readonly p2: Point;
  readonly p3: Point;
}

/** 样条：唯一 ID + 首尾相接的三次贝塞尔段序列。 */
export interface Spline {
  readonly id: string;
  readonly segments: readonly CubicBezierSegment[];
}

/**
 * 选区：一个简单多边形外环 + 零个或多个孔洞。
 * 环为顶点序列（首尾顶点不应重复，库内按闭合处理）。
 */
export interface Region {
  readonly outer: readonly Point[];
  readonly holes?: readonly (readonly Point[])[];
}

/** 选取方式。 */
export type SelectionMode = 'intersect' | 'contain';

/** 样条中心线落在选区内的最大闭参数区间 [start, end]，全局参数。 */
export interface ParamInterval {
  readonly start: number;
  readonly end: number;
}

/** 单条命中样条的结果。 */
export interface SplineSelection {
  readonly id: string;
  readonly intervals: readonly ParamInterval[];
}

/** 样条场景接口：批量装入 + 按区域选取。 */
export interface SplineScene {
  /** 批量装入样条，替换场景原有内容。 */
  loadSplines(splines: readonly Spline[]): void;
  /** 按区域选取，返回命中样条及其在选区内的参数区间。 */
  select(region: Region, mode: SelectionMode): SplineSelection[];
}
