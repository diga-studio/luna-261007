import {
  cubicLineIntersectionParams,
  evalCubic,
  isCollinearWithLine,
  isDegeneratePoint,
  segmentBBox,
} from './bezier.js';
import { pointInRegion } from './polygon.js';
import type { PreparedRegion } from './polygon.js';
import type { CubicBezierSegment, ParamInterval } from './types.js';

/** 候选参数去重间隔（远小于业务要求的最短区间 1e-7）。 */
const DEDUPE_EPS = 1e-12;

interface MutableInterval {
  start: number;
  end: number;
}

function mergeIntervals(intervals: MutableInterval[]): MutableInterval[] {
  intervals.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: MutableInterval[] = [];
  for (const iv of intervals) {
    const last = merged[merged.length - 1];
    // 仅当参数真正相接（共享同一参数位置）时合并；不引入容差，保证 1e-7 间隙不被吞掉
    if (last && iv.start <= last.end) {
      if (iv.end > last.end) last.end = iv.end;
    } else {
      merged.push({ start: iv.start, end: iv.end });
    }
  }
  return merged;
}

/**
 * 计算单条贝塞尔段中心线落在选区内的全部最大闭参数区间（局部参数 0..1）。
 * 边界属于选区；单点接触保留为 start === end 的区间；
 * 整段退化为选区内一点时返回 [0, 1]。
 */
export function clipSegmentToRegion(
  seg: CubicBezierSegment,
  region: PreparedRegion,
  tol: number,
): ParamInterval[] {
  if (isDegeneratePoint(seg, tol)) {
    return pointInRegion(seg.p0, region, tol) ? [{ start: 0, end: 1 }] : [];
  }

  const bbox = segmentBBox(seg);
  const candidates: number[] = [0, 1];

  const rings = [region.outer, ...region.holes];
  for (const ring of rings) {
    for (const e of ring.edges) {
      // 包围盒快速排除
      if (
        bbox.minX > e.maxX + tol || bbox.maxX < e.minX - tol ||
        bbox.minY > e.maxY + tol || bbox.maxY < e.minY - tol
      ) {
        continue;
      }
      const a = { x: e.ax, y: e.ay };
      if (isCollinearWithLine(seg, a, { x: e.bx, y: e.by }, tol)) {
        // 曲线与边共线：重叠区间端点由曲线经过边两个端点的参数界定，
        // 即曲线与“过端点且垂直于边的直线”的交点参数。
        const normal = { x: e.nx, y: e.ny };
        for (const v of [a, { x: e.bx, y: e.by }]) {
          const lineB = { x: v.x + normal.x, y: v.y + normal.y };
          for (const t of cubicLineIntersectionParams(seg, v, lineB, tol)) {
            candidates.push(t);
          }
        }
      } else {
        for (const t of cubicLineIntersectionParams(seg, a, { x: e.bx, y: e.by }, tol)) {
          // 交点必须落在线段上（含 tol）
          const pt = evalCubic(seg, t);
          const s = (pt.x - e.ax) * e.ux + (pt.y - e.ay) * e.uy;
          if (s >= -tol && s <= e.len + tol) {
            candidates.push(t);
          }
        }
      }
    }
  }

  candidates.sort((x, y) => x - y);
  const params: number[] = [];
  for (const t of candidates) {
    const last = params[params.length - 1];
    if (last === undefined || t - last > DEDUPE_EPS) {
      params.push(t);
    }
  }

  const intervals: MutableInterval[] = [];
  // 候选点本身：在选区内（含边界）则保留为点区间
  for (const t of params) {
    if (pointInRegion(evalCubic(seg, t), region, tol)) {
      intervals.push({ start: t, end: t });
    }
  }
  // 相邻候选之间的开区间：取中点分类
  for (let i = 0; i + 1 < params.length; i++) {
    const lo = params[i]!;
    const hi = params[i + 1]!;
    const mid = 0.5 * (lo + hi);
    if (pointInRegion(evalCubic(seg, mid), region, tol)) {
      intervals.push({ start: lo, end: hi });
    }
  }

  return mergeIntervals(intervals);
}
