import test from 'node:test';
import assert from 'node:assert/strict';
import { createSplineScene } from '../src/index.js';
import type { Region, Spline } from '../src/index.js';
import { expectIntervals, lineSeg, pointSeg } from './helpers.js';

// 选区：[-10,10] x [0,10] 矩形，无孔洞。底边 y=0 属于选区。
const halfRegion: Region = {
  outer: [
    { x: -10, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: -10, y: 10 },
  ],
};

// 段0：y = -(2t-1)^2，x = t。仅在 t=0.5 处与底边 y=0 相切，其余在区外。
const tangentSeg = {
  p0: { x: 0, y: -1 },
  p1: { x: 1 / 3, y: 1 / 3 },
  p2: { x: 2 / 3, y: 1 / 3 },
  p3: { x: 1, y: -1 },
};

test('相切、边界重叠、退化点三种形态', () => {
  const spline: Spline = {
    id: 'mixed',
    segments: [
      tangentSeg,
      lineSeg(2, 0, 20, 0), // 段1：沿底边从 x=2 重叠到角点 x=10，之后离开选区
      pointSeg(5, 5),       // 段2：退化为区内一点
    ],
  };
  const scene = createSplineScene();
  scene.loadSplines([spline]);

  const hits = scene.select(halfRegion, 'intersect');
  assert.equal(hits.length, 1);
  expectIntervals(hits[0]!.intervals, [
    [0.5, 0.5],          // 相切：单点区间
    [1, 1 + 4 / 9],      // 重叠：x∈[2,10] 对应局部 t∈[0, 8/18]
    [2, 3],              // 退化点：覆盖整段参数
  ]);

  // 完全包含：三段均非全程在区内，不得选中
  assert.equal(scene.select(halfRegion, 'contain').length, 0);
});

test('整段沿边界重叠返回完整参数区间，且完全包含成立', () => {
  const spline: Spline = { id: 'edge', segments: [lineSeg(-8, 0, 8, 0)] };
  const scene = createSplineScene();
  scene.loadSplines([spline]);

  const hits = scene.select(halfRegion, 'intersect');
  assert.equal(hits.length, 1);
  expectIntervals(hits[0]!.intervals, [[0, 1]]);

  const contained = scene.select(halfRegion, 'contain');
  assert.equal(contained.length, 1);
  expectIntervals(contained[0]!.intervals, [[0, 1]]);
});

test('退化点在区外时不命中', () => {
  const spline: Spline = { id: 'out', segments: [pointSeg(0, -5)] };
  const scene = createSplineScene();
  scene.loadSplines([spline]);
  assert.equal(scene.select(halfRegion, 'intersect').length, 0);
  assert.equal(scene.select(halfRegion, 'contain').length, 0);
});

test('孔洞边界属于选区：沿孔洞边缘的段完全包含', () => {
  const region: Region = {
    outer: [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ],
    holes: [
      [
        { x: 4, y: 4 },
        { x: 6, y: 4 },
        { x: 6, y: 6 },
        { x: 4, y: 6 },
      ],
    ],
  };
  const scene = createSplineScene();
  // 沿孔洞下边缘 y=4 从 (4,4) 到 (6,4)
  scene.loadSplines([{ id: 'rim', segments: [lineSeg(4, 4, 6, 4)] }]);
  const contained = scene.select(region, 'contain');
  assert.equal(contained.length, 1);
  expectIntervals(contained[0]!.intervals, [[0, 1]]);

  // 孔洞内部的退化点不属于选区；孔洞边界上的退化点属于选区
  scene.loadSplines([
    { id: 'in-hole', segments: [pointSeg(5, 5)] },
    { id: 'on-hole-edge', segments: [pointSeg(5, 4)] },
  ]);
  const hits = scene.select(region, 'intersect');
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.id, 'on-hole-edge');
  expectIntervals(hits[0]!.intervals, [[0, 1]]);
});
