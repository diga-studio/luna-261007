import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTableNavigator, type TableInput } from '../src/index';
import { must } from './helpers';

/**
 * 布局（r\c 1..5，'.' 为空洞）：
 *   r1: A  A  .  B  B
 *   r2: A  A  .  .  .
 *   r3: .  C  .  .  .
 *   r4: .  C  .  D  .
 *   r5: E  .  .  .  .
 */
const table: TableInput = {
  rowCount: 5,
  colCount: 5,
  cells: [
    { id: 'a', text: 'A', row: 1, col: 1, rowSpan: 2, colSpan: 2, kind: 'data' },
    { id: 'b', text: 'B', row: 1, col: 4, rowSpan: 1, colSpan: 2, kind: 'data' },
    { id: 'c', text: 'C', row: 3, col: 2, rowSpan: 2, colSpan: 1, kind: 'data' },
    { id: 'd', text: 'D', row: 4, col: 4, rowSpan: 1, colSpan: 1, kind: 'data' },
    { id: 'e', text: 'E', row: 5, col: 1, rowSpan: 1, colSpan: 1, kind: 'data' },
  ],
};

test('定位到合并格内部：落点为所给坐标而非左上角', () => {
  const nav = createTableNavigator(table);
  const res = must(nav.locate(2, 2));
  assert.equal(res.cellId, 'a');
  assert.equal(res.row, 2);
  assert.equal(res.col, 2);
  assert.deepEqual(nav.position, { row: 2, col: 2 });
});

test('定位到空洞或越界坐标：保持原位并返回 null', () => {
  const nav = createTableNavigator(table);
  assert.equal(nav.locate(3, 3), null);
  assert.equal(nav.position, null);
  assert.equal(nav.locate(0, 1), null);
  assert.equal(nav.locate(6, 1), null);
  assert.equal(nav.locate(1, 0), null);
  assert.equal(nav.position, null);
  nav.locate(1, 1);
  assert.equal(nav.locate(3, 1), null);
  assert.deepEqual(nav.position, { row: 1, col: 1 });
});

test('未定位时移动返回 null', () => {
  const nav = createTableNavigator(table);
  assert.equal(nav.move('up'), null);
  assert.equal(nav.move('down'), null);
  assert.equal(nav.move('left'), null);
  assert.equal(nav.move('right'), null);
});

test('水平移动保持行号，从单元格边缘离开并跳过空洞', () => {
  const nav = createTableNavigator(table);
  // 落点在合并格 A 内部 (1,1)，向右应从 A 的右边缘 (col 3) 离开，
  // 跳过 (1,3) 空洞，落在 B 的 (1,4)，而非 A 内部其它坐标。
  nav.locate(1, 1);
  const res = must(nav.move('right'));
  assert.equal(res.cellId, 'b');
  assert.deepEqual({ row: res.row, col: res.col }, { row: 1, col: 4 });
});

test('跨空洞移动后再转向，落点为进入目标格的第一个坐标', () => {
  const nav = createTableNavigator(table);
  nav.locate(1, 2); // A 内部
  // 向右：保持行 1，跨过 (1,3) 空洞，进入 B 于 (1,4)
  let res = must(nav.move('right'));
  assert.deepEqual({ row: res.row, col: res.col }, { row: 1, col: 4 });
  // 转向向下：保持列 4，从 B 下边缘离开，跳过 (2,4)、(3,4) 空洞，落在 D (4,4)
  res = must(nav.move('down'));
  assert.equal(res.cellId, 'd');
  assert.deepEqual({ row: res.row, col: res.col }, { row: 4, col: 4 });
  // 转向向左：保持行 4，跳过 (4,3) 空洞，进入 C 于 (4,2) —— 不是 C 的左上角 (3,2)
  res = must(nav.move('left'));
  assert.equal(res.cellId, 'c');
  assert.deepEqual({ row: res.row, col: res.col }, { row: 4, col: 2 });
  // 转向上：保持列 2，从 C 上边缘离开，进入 A 于 (2,2) —— 不是 A 的左上角 (1,1)
  res = must(nav.move('up'));
  assert.equal(res.cellId, 'a');
  assert.deepEqual({ row: res.row, col: res.col }, { row: 2, col: 2 });
});

test('竖直移动保持列号，进入合并格时为路径上首个坐标', () => {
  const nav = createTableNavigator(table);
  nav.locate(2, 2); // A 内部
  // 向下：从 A 的下边缘 (row 3) 离开，(3,2) 即 C，落点 (3,2)
  const res = must(nav.move('down'));
  assert.equal(res.cellId, 'c');
  assert.deepEqual({ row: res.row, col: res.col }, { row: 3, col: 2 });
});

test('没有目标时保持原位', () => {
  const nav = createTableNavigator(table);
  nav.locate(4, 2); // C 内部
  // 向下：C 下边缘之外 (5,2) 是空洞，无目标
  assert.equal(nav.move('down'), null);
  assert.deepEqual(nav.position, { row: 4, col: 2 });
  // 向左：(4,1) 是空洞，无目标
  assert.equal(nav.move('left'), null);
  assert.deepEqual(nav.position, { row: 4, col: 2 });
  // 向上出界
  const nav2 = createTableNavigator(table);
  nav2.locate(1, 4);
  assert.equal(nav2.move('up'), null);
  assert.deepEqual(nav2.position, { row: 1, col: 4 });
  // 向右出界
  assert.equal(nav2.move('right'), null);
  assert.deepEqual(nav2.position, { row: 1, col: 4 });
});
