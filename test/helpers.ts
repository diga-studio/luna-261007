import assert from 'node:assert/strict';
import type { CubicBezierSegment, ParamInterval, Point } from '../src/index.js';

export function pt(x: number, y: number): Point {
  return { x, y };
}

/** 构造退化为直线的三次贝塞尔段（控制点共线等距）。 */
export function lineSeg(x0: number, y0: number, x1: number, y1: number): CubicBezierSegment {
  return {
    p0: { x: x0, y: y0 },
    p1: { x: x0 + (x1 - x0) / 3, y: y0 + (y1 - y0) / 3 },
    p2: { x: x0 + (2 * (x1 - x0)) / 3, y: y0 + (2 * (y1 - y0)) / 3 },
    p3: { x: x1, y: y1 },
  };
}

/** 构造退化为单点的三次贝塞尔段。 */
export function pointSeg(x: number, y: number): CubicBezierSegment {
  const p = { x, y };
  return { p0: p, p1: p, p2: p, p3: p };
}

/** 断言实际区间与期望区间逐一一致（端点误差 ≤ tol）。 */
export function expectIntervals(
  actual: readonly ParamInterval[],
  expected: readonly (readonly [number, number])[],
  tol = 1e-9,
): void {
  assert.equal(
    actual.length,
    expected.length,
    `interval count mismatch: actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`,
  );
  for (let i = 0; i < expected.length; i++) {
    const a = actual[i]!;
    const e = expected[i]!;
    assert.ok(
      Math.abs(a.start - e[0]) <= tol,
      `interval[${i}].start: actual=${a.start} expected=${e[0]}`,
    );
    assert.ok(
      Math.abs(a.end - e[1]) <= tol,
      `interval[${i}].end: actual=${a.end} expected=${e[1]}`,
    );
  }
}
