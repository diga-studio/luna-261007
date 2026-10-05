import type { Point } from './types.js';

/** 预处理后的边：单位方向、单位法线、长度与包围盒。 */
export interface PreparedEdge {
  readonly ax: number;
  readonly ay: number;
  readonly bx: number;
  readonly by: number;
  readonly ux: number;
  readonly uy: number;
  readonly nx: number;
  readonly ny: number;
  readonly len: number;
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

export interface PreparedRing {
  readonly points: readonly Point[];
  readonly edges: readonly PreparedEdge[];
}

export interface PreparedRegion {
  readonly outer: PreparedRing;
  readonly holes: readonly PreparedRing[];
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

function prepareEdge(a: Point, b: Point): PreparedEdge | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return null;
  const ux = dx / len;
  const uy = dy / len;
  return {
    ax: a.x, ay: a.y, bx: b.x, by: b.y,
    ux, uy,
    nx: -uy, ny: ux,
    len,
    minX: Math.min(a.x, b.x), minY: Math.min(a.y, b.y),
    maxX: Math.max(a.x, b.x), maxY: Math.max(a.y, b.y),
  };
}

export function prepareRing(points: readonly Point[]): PreparedRing {
  const edges: PreparedEdge[] = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    const e = prepareEdge(a, b);
    if (e) edges.push(e);
  }
  return { points, edges };
}

export function prepareRegion(
  outer: readonly Point[],
  holes: readonly (readonly Point[])[],
): PreparedRegion {
  const outerRing = prepareRing(outer);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of outer) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { outer: outerRing, holes: holes.map(prepareRing), minX, minY, maxX, maxY };
}

/** 点是否在环边界上（容差 tol，英尺）。 */
export function pointOnRing(p: Point, ring: PreparedRing, tol: number): boolean {
  for (const e of ring.edges) {
    if (
      p.x < e.minX - tol || p.x > e.maxX + tol ||
      p.y < e.minY - tol || p.y > e.maxY + tol
    ) {
      continue;
    }
    // 法线为单位向量，|(p-a)·n| 即点到边所在直线的距离
    const dist = (p.x - e.ax) * e.nx + (p.y - e.ay) * e.ny;
    if (Math.abs(dist) > tol) continue;
    const s = (p.x - e.ax) * e.ux + (p.y - e.ay) * e.uy;
    if (s >= -tol && s <= e.len + tol) return true;
  }
  return false;
}

/** 点是否在环内或边界上（射线法 + 边界判定）。 */
export function pointInRing(p: Point, ring: PreparedRing, tol: number): boolean {
  if (pointOnRing(p, ring, tol)) return true;
  let inside = false;
  for (const e of ring.edges) {
    if (e.ay > p.y !== e.by > p.y) {
      const xCross = e.ax + ((p.y - e.ay) / (e.by - e.ay)) * (e.bx - e.ax);
      if (xCross > p.x) inside = !inside;
    }
  }
  return inside;
}

/** 点是否严格在环内部（不含边界）。 */
function pointStrictlyInRing(p: Point, ring: PreparedRing, tol: number): boolean {
  return pointInRing(p, ring, tol) && !pointOnRing(p, ring, tol);
}

/** 点是否属于选区（外环内部含边界，排除孔洞内部，孔洞边界属于选区）。 */
export function pointInRegion(p: Point, region: PreparedRegion, tol: number): boolean {
  if (!pointInRing(p, region.outer, tol)) return false;
  for (const hole of region.holes) {
    if (pointStrictlyInRing(p, hole, tol)) return false;
  }
  return true;
}
