import { segmentBBox } from './bezier.js';
import { clipSegmentToRegion } from './clip.js';
import { prepareRegion } from './polygon.js';
import type {
  ParamInterval,
  Region,
  SelectionMode,
  Spline,
  SplineScene,
  SplineSelection,
} from './types.js';

interface MutableInterval {
  start: number;
  end: number;
}

/** 创建内存样条场景。 */
export function createSplineScene(): SplineScene {
  let splines: readonly Spline[] = [];

  return {
    loadSplines(next: readonly Spline[]): void {
      splines = next.slice();
    },

    select(region: Region, mode: SelectionMode): SplineSelection[] {
      const holes = region.holes ?? [];
      const prepared = prepareRegion(region.outer, holes);

      // 由坐标规模确定几何容差：绝对下限 1e-9 英尺，相对规模 1e-12
      let scale = 1;
      const absorb = (v: number) => {
        const a = Math.abs(v);
        if (a > scale) scale = a;
      };
      for (const p of region.outer) { absorb(p.x); absorb(p.y); }
      for (const h of holes) for (const p of h) { absorb(p.x); absorb(p.y); }
      for (const s of splines) {
        for (const seg of s.segments) {
          for (const p of [seg.p0, seg.p1, seg.p2, seg.p3]) {
            absorb(p.x); absorb(p.y);
          }
        }
      }
      const tol = Math.max(1e-9, scale * 1e-12);

      const results: SplineSelection[] = [];
      for (const spline of splines) {
        const segs = spline.segments;
        const n = segs.length;
        if (n === 0) continue;

        const merged: MutableInterval[] = [];
        let containFailed = false;

        for (let i = 0; i < n; i++) {
          const seg = segs[i]!;
          const bbox = segmentBBox(seg);
          const outsideRegionBBox =
            bbox.minX > prepared.maxX + tol || bbox.maxX < prepared.minX - tol ||
            bbox.minY > prepared.maxY + tol || bbox.maxY < prepared.minY - tol;
          if (outsideRegionBBox) {
            if (mode === 'contain') { containFailed = true; break; }
            continue;
          }

          const local = clipSegmentToRegion(seg, prepared, tol);
          for (const iv of local) {
            const gStart = i + iv.start;
            const gEnd = i + iv.end;
            const last = merged[merged.length - 1];
            // 相邻段共享的连接点只有一个全局参数位置：恰好相接即合并
            if (last && gStart <= last.end) {
              if (gEnd > last.end) last.end = gEnd;
            } else {
              merged.push({ start: gStart, end: gEnd });
            }
          }
        }

        if (containFailed) continue;

        let hit: boolean;
        if (mode === 'contain') {
          const only = merged.length === 1 ? merged[0]! : undefined;
          hit = only !== undefined && only.start === 0 && only.end === n;
        } else {
          hit = merged.length > 0;
        }
        if (!hit) continue;

        const intervals: ParamInterval[] = merged.map((iv) => ({
          start: iv.start,
          end: iv.end,
        }));
        results.push({ id: spline.id, intervals });
      }
      return results;
    },
  };
}
