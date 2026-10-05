import test from 'node:test';
import assert from 'node:assert/strict';
import { createSplineScene } from '../src/index.js';
import type { CubicBezierSegment, Region, Spline } from '../src/index.js';
import { expectIntervals } from './helpers.js';

// 三次贝塞尔精确表示抛物线 y = x^2（x 从 -2 到 2，x = 4t - 2）。
const parabola: CubicBezierSegment = {
  p0: { x: -2, y: 4 },
  p1: { x: -2 / 3, y: -4 / 3 },
  p2: { x: 2 / 3, y: -4 / 3 },
  p3: { x: 2, y: 4 },
};

// 选区：[-3,3] x [1,9]，下边界 y=1 与抛物线交于 x=±1。
const bandRegion: Region = {
  outer: [
    { x: -3, y: 1 },
    { x: 3, y: 1 },
    { x: 3, y: 9 },
    { x: -3, y: 9 },
  ],
};

test('真实曲线：抛物线两次穿越边界，端点参数与独立解一致', () => {
  const spline: Spline = { id: 'parabola', segments: [parabola] };
  const scene = createSplineScene();
  scene.loadSplines([spline]);

  const hits = scene.select(bandRegion, 'intersect');
  assert.equal(hits.length, 1);
  // y >= 1 <=> |x| >= 1 <=> t <= 0.25 或 t >= 0.75
  expectIntervals(hits[0]!.intervals, [
    [0, 0.25],
    [0.75, 1],
  ]);

  // 首尾均在区内但中途穿出 => 完全包含不得选中
  assert.equal(scene.select(bandRegion, 'contain').length, 0);
});

test('真实曲线：整体在区内的抛物线段完全包含', () => {
  // 同一抛物线，选区改为 [-3,3] x [-1,9]：整条曲线 y∈[0,4] 都在区内
  const region: Region = {
    outer: [
      { x: -3, y: -1 },
      { x: 3, y: -1 },
      { x: 3, y: 9 },
      { x: -3, y: 9 },
    ],
  };
  const spline: Spline = { id: 'parabola', segments: [parabola] };
  const scene = createSplineScene();
  scene.loadSplines([spline]);

  const contained = scene.select(region, 'contain');
  assert.equal(contained.length, 1);
  expectIntervals(contained[0]!.intervals, [[0, 1]]);
});

test('曲线与边界相切：抛物线顶点恰好接触下边界', () => {
  // 选区 [-3,3] x [0,9]：抛物线顶点 (0,0) 恰好落在下边界上，其余 y>0 在区内
  const region: Region = {
    outer: [
      { x: -3, y: 0 },
      { x: 3, y: 0 },
      { x: 3, y: 9 },
      { x: -3, y: 9 },
    ],
  };
  const spline: Spline = { id: 'tangent-curve', segments: [parabola] };
  const scene = createSplineScene();
  scene.loadSplines([spline]);

  const contained = scene.select(region, 'contain');
  assert.equal(contained.length, 1);
  expectIntervals(contained[0]!.intervals, [[0, 1]]);
});
