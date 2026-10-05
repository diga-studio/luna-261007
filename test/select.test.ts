import test from 'node:test';
import assert from 'node:assert/strict';
import { createSplineScene } from '../src/index.js';
import type { Region, Spline } from '../src/index.js';
import { expectIntervals, lineSeg } from './helpers.js';

// 凹形外环：10x10 矩形，顶部中央有 x∈[4,6]、y∈[6,10] 的凹槽；
// 孔洞：(7,7)-(9,9) 矩形，严格位于外环内部。
const concaveRegionWithHole: Region = {
  outer: [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 6, y: 10 },
    { x: 6, y: 6 },
    { x: 4, y: 6 },
    { x: 4, y: 10 },
    { x: 0, y: 10 },
  ],
  holes: [
    [
      { x: 7, y: 7 },
      { x: 9, y: 7 },
      { x: 9, y: 9 },
      { x: 7, y: 9 },
    ],
  ],
};

test('凹形选区带孔洞：同一段多次进出且首尾均在区内', () => {
  // 水平直线 y=8，从 (1,8) 到 (9.5,8)，速度 8.5 英尺/单位参数。
  // 依次：区内 → 凹槽(区外) → 区内 → 孔洞(区外) → 区内。
  const spline: Spline = { id: 's1', segments: [lineSeg(1, 8, 9.5, 8)] };
  const scene = createSplineScene();
  scene.loadSplines([spline]);

  const hits = scene.select(concaveRegionWithHole, 'intersect');
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.id, 's1');
  // 独立计算的期望：t = (x - 1) / 8.5，x 边界为 4、6、7、9
  expectIntervals(hits[0]!.intervals, [
    [0, 3 / 8.5],
    [5 / 8.5, 6 / 8.5],
    [8 / 8.5, 1],
  ]);

  // 完全包含：中途穿出区外，不得选中
  const contained = scene.select(concaveRegionWithHole, 'contain');
  assert.equal(contained.length, 0);
});

test('完全包含：整段在区内的样条被选中，区间覆盖全参数', () => {
  const spline: Spline = { id: 'inside', segments: [lineSeg(1, 1, 3, 1)] };
  const scene = createSplineScene();
  scene.loadSplines([spline]);

  const contained = scene.select(concaveRegionWithHole, 'contain');
  assert.equal(contained.length, 1);
  expectIntervals(contained[0]!.intervals, [[0, 1]]);
});

test('空场景与装入替换语义', () => {
  const scene = createSplineScene();
  assert.deepEqual(scene.select(concaveRegionWithHole, 'intersect'), []);
  scene.loadSplines([{ id: 'a', segments: [lineSeg(1, 1, 2, 1)] }]);
  assert.equal(scene.select(concaveRegionWithHole, 'intersect').length, 1);
  scene.loadSplines([{ id: 'b', segments: [lineSeg(100, 100, 101, 101)] }]);
  const hits = scene.select(concaveRegionWithHole, 'intersect');
  assert.deepEqual(hits, []);
});
