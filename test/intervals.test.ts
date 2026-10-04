import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampInterval, intersectIntervals, mergeIntervals, subtractIntervals } from '../src/intervals.js';

test('mergeIntervals 合并重叠与首尾相接', () => {
  assert.deepEqual(
    mergeIntervals([
      { start: 10, end: 20 },
      { start: 0, end: 5 },
      { start: 5, end: 10 },
      { start: 15, end: 25 },
    ]),
    [
      { start: 0, end: 10 },
      { start: 10, end: 25 },
    ].length === 2 ? [{ start: 0, end: 25 }] : [],
  );
});

test('mergeIntervals 空输入与单区间', () => {
  assert.deepEqual(mergeIntervals([]), []);
  assert.deepEqual(mergeIntervals([{ start: 1, end: 2 }]), [{ start: 1, end: 2 }]);
});

test('intersectIntervals 求交', () => {
  assert.deepEqual(
    intersectIntervals(
      [
        { start: 0, end: 10 },
        { start: 20, end: 30 },
      ],
      [
        { start: 5, end: 25 },
        { start: 40, end: 50 },
      ],
    ),
    [
      { start: 5, end: 10 },
      { start: 20, end: 25 },
    ],
  );
  assert.deepEqual(intersectIntervals([{ start: 0, end: 5 }], [{ start: 5, end: 9 }]), []);
});

test('subtractIntervals 扣除后拆段', () => {
  assert.deepEqual(
    subtractIntervals([{ start: 0, end: 100 }], [
      { start: 10, end: 20 },
      { start: 50, end: 60 },
      { start: 55, end: 70 },
    ]),
    [
      { start: 0, end: 10 },
      { start: 20, end: 50 },
      { start: 70, end: 100 },
    ],
  );
});

test('subtractIntervals 完全覆盖与无覆盖', () => {
  assert.deepEqual(subtractIntervals([{ start: 0, end: 10 }], [{ start: -5, end: 20 }]), []);
  assert.deepEqual(subtractIntervals([{ start: 0, end: 10 }], [{ start: 20, end: 30 }]), [
    { start: 0, end: 10 },
  ]);
});

test('clampInterval 裁剪', () => {
  assert.deepEqual(clampInterval({ start: 0, end: 100 }, 10, 50), { start: 10, end: 50 });
  assert.equal(clampInterval({ start: 0, end: 5 }, 10, 50), null);
  assert.deepEqual(clampInterval({ start: 0, end: Infinity }, 10, 50), { start: 10, end: 50 });
});
