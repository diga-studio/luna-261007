import { test } from 'node:test';
import assert from 'node:assert/strict';
import { intersectSpans, mergeSpans, subtractSpans } from '../src/intervals';

test('mergeSpans 合并重叠与首尾相接区间', () => {
  assert.deepEqual(
    mergeSpans([
      { start: 10, end: 20 },
      { start: 0, end: 5 },
      { start: 5, end: 10 }, // 与 [0,5) 首尾相接
      { start: 15, end: 25 }, // 与 [10,20) 重叠
      { start: 30, end: 40 },
    ]),
    [
      { start: 0, end: 25 },
      { start: 30, end: 40 },
    ],
  );
});

test('mergeSpans 空输入与单区间', () => {
  assert.deepEqual(mergeSpans([]), []);
  assert.deepEqual(mergeSpans([{ start: 1, end: 2 }]), [{ start: 1, end: 2 }]);
});

test('subtractSpans 扣除覆盖部分并可拆分区间', () => {
  assert.deepEqual(
    subtractSpans(
      [{ start: 0, end: 100 }],
      [
        { start: 10, end: 20 },
        { start: 15, end: 30 }, // 与上一个重叠，应视为整体 [10,30)
        { start: 50, end: 60 },
      ],
    ),
    [
      { start: 0, end: 10 },
      { start: 30, end: 50 },
      { start: 60, end: 100 },
    ],
  );
});

test('subtractSpans 完全扣除与无扣除', () => {
  assert.deepEqual(subtractSpans([{ start: 0, end: 10 }], [{ start: 0, end: 10 }]), []);
  assert.deepEqual(subtractSpans([{ start: 0, end: 10 }], [{ start: 20, end: 30 }]), [
    { start: 0, end: 10 },
  ]);
  assert.deepEqual(subtractSpans([], [{ start: 0, end: 10 }]), []);
});

test('intersectSpans 求交', () => {
  assert.deepEqual(
    intersectSpans(
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
  assert.deepEqual(intersectSpans([{ start: 0, end: 10 }], [{ start: 10, end: 20 }]), []);
});
