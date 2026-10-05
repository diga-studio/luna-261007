import type { Vec2 } from "./types.js";
/** 求三次贝塞尔曲线在参数 t 处的点（de Casteljau）。 */
export declare function evalCubic(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, t: number): Vec2;
/** 三次贝塞尔曲线的导数在参数 t 处的值。 */
export declare function evalCubicDeriv(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, t: number): Vec2;
/**
 * 求三次多项式 a3 t^3 + a2 t^2 + a1 t + a0 = 0 在 [0,1] 内的实根（升序、去重）。
 * 解析求解后再用牛顿法对原多项式做精化。
 */
export declare function cubicRoots01(a3: number, a2: number, a1: number, a0: number): number[];
/**
 * 点是否属于选区（外环内部含边界，减去孔洞内部；孔洞边界仍属选区）。
 */
export declare function pointInRegion(p: Vec2, outer: readonly Vec2[], holes: readonly (readonly Vec2[])[]): boolean;
