import type { CubicBezierSegment, Point } from './types.js';

/** 求三次贝塞尔在参数 t 处的点。 */
export function evalCubic(seg: CubicBezierSegment, t: number): Point {
  const mt = 1 - t;
  const w0 = mt * mt * mt;
  const w1 = 3 * mt * mt * t;
  const w2 = 3 * mt * t * t;
  const w3 = t * t * t;
  return {
    x: w0 * seg.p0.x + w1 * seg.p1.x + w2 * seg.p2.x + w3 * seg.p3.x,
    y: w0 * seg.p0.y + w1 * seg.p1.y + w2 * seg.p2.y + w3 * seg.p3.y,
  };
}

/** 段控制点的包围盒。 */
export function segmentBBox(seg: CubicBezierSegment): {
  minX: number; minY: number; maxX: number; maxY: number;
} {
  return {
    minX: Math.min(seg.p0.x, seg.p1.x, seg.p2.x, seg.p3.x),
    minY: Math.min(seg.p0.y, seg.p1.y, seg.p2.y, seg.p3.y),
    maxX: Math.max(seg.p0.x, seg.p1.x, seg.p2.x, seg.p3.x),
    maxY: Math.max(seg.p0.y, seg.p1.y, seg.p2.y, seg.p3.y),
  };
}

/** 判断段是否退化为点（所有控制点在 tol 内重合）。 */
export function isDegeneratePoint(seg: CubicBezierSegment, tol: number): boolean {
  return (
    Math.hypot(seg.p1.x - seg.p0.x, seg.p1.y - seg.p0.y) <= tol &&
    Math.hypot(seg.p2.x - seg.p0.x, seg.p2.y - seg.p0.y) <= tol &&
    Math.hypot(seg.p3.x - seg.p0.x, seg.p3.y - seg.p0.y) <= tol
  );
}

/** 判断段的四个控制点是否都在过 a、b 的直线的 tol 范围内。 */
export function isCollinearWithLine(
  seg: CubicBezierSegment,
  a: Point,
  b: Point,
  tol: number,
): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return false;
  const nx = -dy / len;
  const ny = dx / len;
  for (const p of [seg.p0, seg.p1, seg.p2, seg.p3]) {
    if (Math.abs((p.x - a.x) * nx + (p.y - a.y) * ny) > tol) return false;
  }
  return true;
}

/** 二分求根：p 在 [lo, hi] 上单调且异号，返回中点，参数误差 ≤ 5e-13。 */
function bisectRoot(
  f: (t: number) => number,
  lo: number,
  hi: number,
  fLo: number,
): number {
  let a = lo;
  let b = hi;
  let fa = fLo;
  for (let i = 0; i < 60; i++) {
    if (b - a <= 1e-12) break;
    const m = 0.5 * (a + b);
    const fm = f(m);
    if (fa * fm <= 0) {
      b = m;
    } else {
      a = m;
      fa = fm;
    }
  }
  return 0.5 * (a + b);
}

/**
 * 求三次多项式 c0 + c1 t + c2 t^2 + c3 t^3 在 [0,1] 上的全部零点，
 * 包括相切零点（函数值在 zeroTol 内视为零）。返回升序参数。
 */
export function solveCubicZeros(
  c0: number,
  c1: number,
  c2: number,
  c3: number,
  zeroTol: number,
): number[] {
  // 忽略对 [0,1] 上函数值影响可忽略的高次项
  const dropTol = zeroTol * 1e-3;
  let d0 = c0, d1 = c1, d2 = c2, d3 = c3;
  if (Math.abs(d3) <= dropTol) {
    d3 = 0;
    if (Math.abs(d2) <= dropTol) {
      d2 = 0;
      if (Math.abs(d1) <= dropTol) {
        d1 = 0;
      }
    }
  }

  const snap = (t: number): number => {
    if (t < 1e-12) return 0;
    if (t > 1 - 1e-12) return 1;
    return t;
  };
  const roots: number[] = [];
  const push = (t: number) => {
    if (t >= -1e-12 && t <= 1 + 1e-12) {
      roots.push(snap(t));
    }
  };

  if (d3 === 0 && d2 === 0 && d1 === 0) {
    return roots; // 常数多项式：无孤立零点（恒零情形由调用方另行处理）
  }

  if (d3 === 0 && d2 === 0) {
    push(-d0 / d1);
    return roots;
  }

  if (d3 === 0) {
    // 二次
    const disc = d1 * d1 - 4 * d2 * d0;
    const scale = Math.abs(d1 * d1) + Math.abs(4 * d2 * d0);
    if (disc < 0 && Math.abs(disc) <= 1e-9 * scale) {
      push(-d1 / (2 * d2)); // 相切
    } else if (disc >= 0) {
      const sq = Math.sqrt(disc);
      const q = d1 >= 0 ? -0.5 * (d1 + sq) : -0.5 * (d1 - sq);
      if (q !== 0) push(d0 / q);
      if (d2 !== 0) push(q / d2);
    }
    return roots.sort((x, y) => x - y);
  }

  // 三次：用导数零点划分单调区间
  const f = (t: number) => d0 + d1 * t + d2 * t * t + d3 * t * t * t;
  const crit: number[] = [];
  {
    // 3 d3 t^2 + 2 d2 t + d1 = 0
    const qa = 3 * d3;
    const qb = 2 * d2;
    const qc = d1;
    const disc = qb * qb - 4 * qa * qc;
    if (disc > 0) {
      const sq = Math.sqrt(disc);
      const q = qb >= 0 ? -0.5 * (qb + sq) : -0.5 * (qb - sq);
      const r1 = q / qa;
      const r2 = qc / q;
      for (const r of [r1, r2]) {
        if (r > 1e-13 && r < 1 - 1e-13) crit.push(r);
      }
    }
    crit.sort((x, y) => x - y);
  }

  const bounds = [0, ...crit, 1];
  const values = bounds.map(f);
  const seen = new Set<number>();
  const addRoot = (t: number) => {
    const s = snap(t);
    for (const r of seen) {
      if (Math.abs(r - s) <= 1e-12) return;
    }
    seen.add(s);
    roots.push(s);
  };

  for (let i = 0; i < bounds.length; i++) {
    if (Math.abs(values[i]!) <= zeroTol) addRoot(bounds[i]!);
  }
  for (let i = 0; i + 1 < bounds.length; i++) {
    const lo = bounds[i]!;
    const hi = bounds[i + 1]!;
    const vLo = values[i]!;
    const vHi = values[i + 1]!;
    if (Math.abs(vLo) <= zeroTol || Math.abs(vHi) <= zeroTol) continue;
    if (vLo * vHi < 0) addRoot(bisectRoot(f, lo, hi, vLo));
  }
  return roots.sort((x, y) => x - y);
}

/**
 * 求三次贝塞尔与过 a、b 两点的直线交点的参数 t ∈ [0,1]（含相切接触）。
 * zeroTol 为“点到直线距离视为零”的容差（英尺）。
 */
export function cubicLineIntersectionParams(
  seg: CubicBezierSegment,
  a: Point,
  b: Point,
  zeroTol: number,
): number[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return [];
  const nx = -dy / len;
  const ny = dx / len;
  // 幂基系数：B(t) = b0 + b1 t + b2 t^2 + b3 t^3
  const b0x = seg.p0.x;
  const b0y = seg.p0.y;
  const b1x = 3 * (seg.p1.x - seg.p0.x);
  const b1y = 3 * (seg.p1.y - seg.p0.y);
  const b2x = 3 * (seg.p0.x - 2 * seg.p1.x + seg.p2.x);
  const b2y = 3 * (seg.p0.y - 2 * seg.p1.y + seg.p2.y);
  const b3x = -seg.p0.x + 3 * seg.p1.x - 3 * seg.p2.x + seg.p3.x;
  const b3y = -seg.p0.y + 3 * seg.p1.y - 3 * seg.p2.y + seg.p3.y;
  const c0 = (b0x - a.x) * nx + (b0y - a.y) * ny;
  const c1 = b1x * nx + b1y * ny;
  const c2 = b2x * nx + b2y * ny;
  const c3 = b3x * nx + b3y * ny;
  return solveCubicZeros(c0, c1, c2, c3, zeroTol);
}
