import test from 'node:test';
import assert from 'node:assert/strict';
import { createSplineScene } from '../src/index.js';
import type { Region, Spline } from '../src/index.js';
import { expectIntervals, lineSeg } from './helpers.js';

// 外环：10x10 矩形，顶部带 x∈[3, 3+1e-6]、y∈[10,12] 的细长凸出（凹多边形）。
// 孔洞：[5, 5+1e-6] x [4, 6] 的细长矩形，严格位于外环内部。
const thinRegion: Region = {
  outer: [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 3 + 1e-6, y: 10 },
    { x: 3 + 1e-6, y: 12 },
    { x: 3, y: 12 },
    { x: 3, y: 10 },
    { x: 0, y: 10 },
  ],
  holes: [
    [
      { x: 5, y: 4 },
      { x: 5 + 1e-6, y: 4 },
      { x: 5 + 1e-6, y: 6 },
      { x: 5, y: 6 },
    ],
  ],
};

test('短至 1e-7 的间隙不被合并', () => {
  // 水平线 y=5 穿过细长孔洞：孔内参数宽度 = 1e-6 / 10 = 1e-7
  const spline: Spline = { id: 'gap', segments: [lineSeg(0, 5, 10, 5)] };
  const scene = createSplineScene();
  scene.loadSplines([spline]);

  const hits = scene.select(thinRegion, 'intersect');
  assert.equal(hits.length, 1);
  expectIntervals(hits[0]!.intervals, [
    [0, 0.5],
    [0.5 + 1e-7, 1],
  ]);

  // 间隙存在 => 非完全包含
  assert.equal(scene.select(thinRegion, 'contain').length, 0);
});

test('短至 1e-7 的命中区间不遗漏', () => {
  // 水平线 y=11 仅在细长凸出内穿过选区：区间宽度 = 1e-6 / 10 = 1e-7
  const spline: Spline = { id: 'thin', segments: [lineSeg(0, 11, 10, 11)] };
  const scene = createSplineScene();
  scene.loadSplines([spline]);

  const hits = scene.select(thinRegion, 'intersect');
  assert.equal(hits.length, 1);
  expectIntervals(hits[0]!.intervals, [[0.3, 0.3 + 1e-7]]);
});

test('跨段连接点不重复返回，区间在连接处合并', () => {
  // 两段首尾相接的直线，全程在区内：应合并为单一区间 [0, 2]
  const spline: Spline = {
    id: 'joint',
    segments: [lineSeg(1, 1, 3, 1), lineSeg(3, 1, 5, 1)],
  };
  const scene = createSplineScene();
  scene.loadSplines([spline]);

  const hits = scene.select(thinRegion, 'intersect');
  assert.equal(hits.length, 1);
  expectIntervals(hits[0]!.intervals, [[0, 2]]);

  const contained = scene.select(thinRegion, 'contain');
  assert.equal(contained.length, 1);
  expectIntervals(contained[0]!.intervals, [[0, 2]]);
});

test('不同参数经过同一坐标不因此合并', () => {
  // 段0 从 (8,5) 到 (12,5)，段1 原路返回。坐标 (10,5) 在 t=0.5 与 t=1.5 各经过一次。
  const spline: Spline = {
    id: 'back',
    segments: [lineSeg(8, 5, 12, 5), lineSeg(12, 5, 8, 5)],
  };
  const scene = createSplineScene();
  scene.loadSplines([spline]);

  const hits = scene.select(thinRegion, 'intersect');
  assert.equal(hits.length, 1);
  expectIntervals(hits[0]!.intervals, [
    [0, 0.5],
    [1.5, 2],
  ]);
});

test('闭合样条：参数 0 与末端参数是不同位置，不回绕合并', () => {
  // 闭合三角形 (1,1) -> (12,1) -> (12,-2) -> (1,1)，选区为 10x10 矩形。
  const region: Region = {
    outer: [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ],
  };
  const spline: Spline = {
    id: 'closed',
    segments: [
      lineSeg(1, 1, 12, 1),   // 区内 x∈[1,10]：t∈[0, 9/11]
      lineSeg(12, 1, 12, -2), // 全程区外
      lineSeg(12, -2, 1, 1),  // 从 y=0 边进入：t∈[2/3, 1]
    ],
  };
  const scene = createSplineScene();
  scene.loadSplines([spline]);

  const hits = scene.select(region, 'intersect');
  assert.equal(hits.length, 1);
  // 首尾坐标同为 (1,1)，但 [0, 9/11] 与 [8/3, 3] 不得合并
  expectIntervals(hits[0]!.intervals, [
    [0, 9 / 11],
    [8 / 3, 3],
  ]);
});
