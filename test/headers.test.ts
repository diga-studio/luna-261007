import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createTableNavigator,
  type CellInput,
  type TableInput,
} from '../src/index';
import { must } from './helpers';

/**
 * 多级表头小表（r\c 1..4，'.' 为空洞）：
 *   r1: .   CH1(跨c2-3)  CH2
 *   r2: .   DUP  DUP  CH5        （ch3/ch4 同文不同编号）
 *   r3: RH1 d1   d2   d3(显式[ch3])
 *   r4: RH2 d4   d5(显式重复)  d6(显式空)
 *   r5: RH2 d7(跨c2-4)
 * RH2 为跨两行的行表头；d7 跨越全部列表头范围。
 */
const cells: CellInput[] = [
  { id: 'ch1', text: 'CH1', row: 1, col: 2, rowSpan: 1, colSpan: 2, kind: 'col-header' },
  { id: 'ch2', text: 'CH2', row: 1, col: 4, rowSpan: 1, colSpan: 1, kind: 'col-header' },
  { id: 'ch3', text: 'DUP', row: 2, col: 2, rowSpan: 1, colSpan: 1, kind: 'col-header' },
  { id: 'ch4', text: 'DUP', row: 2, col: 3, rowSpan: 1, colSpan: 1, kind: 'col-header' },
  { id: 'ch5', text: 'CH5', row: 2, col: 4, rowSpan: 1, colSpan: 1, kind: 'col-header' },
  { id: 'rh1', text: 'RH1', row: 3, col: 1, rowSpan: 1, colSpan: 1, kind: 'row-header' },
  { id: 'rh2', text: 'RH2', row: 4, col: 1, rowSpan: 2, colSpan: 1, kind: 'row-header' },
  { id: 'd1', text: '1', row: 3, col: 2, rowSpan: 1, colSpan: 1, kind: 'data' },
  { id: 'd2', text: '2', row: 3, col: 3, rowSpan: 1, colSpan: 1, kind: 'data' },
  // 显式只引用 ch3：ch3 自身的表头 ch1 不得递归展开进来
  { id: 'd3', text: '3', row: 3, col: 4, rowSpan: 1, colSpan: 1, kind: 'data', headers: ['ch3'] },
  { id: 'd4', text: '4', row: 4, col: 2, rowSpan: 1, colSpan: 1, kind: 'data' },
  // 显式重复引用 + 保持给定次序 + 同文表头不合并
  { id: 'd5', text: '5', row: 4, col: 3, rowSpan: 1, colSpan: 1, kind: 'data', headers: ['ch4', 'ch1', 'ch4', 'ch3', 'rh2', 'rh2'] },
  // 显式空关联：不报表头
  { id: 'd6', text: '6', row: 4, col: 4, rowSpan: 1, colSpan: 1, kind: 'data', headers: [] },
  // 跨多个表头范围的数据格
  { id: 'd7', text: '7', row: 5, col: 2, rowSpan: 1, colSpan: 3, kind: 'data' },
];

const table: TableInput = { rowCount: 5, colCount: 4, cells };

const textById = new Map(cells.map((c) => [c.id, c.text]));

/** 每个单元格期望的有序表头编号序列。 */
const expectedHeaders: Record<string, string[]> = {
  ch1: [],
  ch2: [],
  ch3: ['ch1'],
  ch4: ['ch1'],
  ch5: ['ch2'],
  rh1: [],
  rh2: [],
  d1: ['ch1', 'ch3', 'rh1'],
  d2: ['ch1', 'ch4', 'rh1'],
  d3: ['ch3'],
  d4: ['ch1', 'ch3', 'rh2'],
  d5: ['ch4', 'ch1', 'ch3', 'rh2'],
  d6: [],
  d7: ['ch1', 'ch2', 'ch3', 'ch4', 'ch5', 'rh2'],
};

test('全部已覆盖坐标返回的有序表头均符合规则', () => {
  const nav = createTableNavigator(table);
  for (const cell of cells) {
    const expected = expectedHeaders[cell.id];
    assert.ok(expected, `missing expectation for ${cell.id}`);
    for (let r = cell.row; r < cell.row + cell.rowSpan; r++) {
      for (let c = cell.col; c < cell.col + cell.colSpan; c++) {
        const res = must(nav.locate(r, c));
        assert.equal(res.cellId, cell.id, `cell at (${r},${c})`);
        assert.deepEqual(
          res.headers.map((h) => h.id),
          expected,
          `headers of ${cell.id} at (${r},${c})`,
        );
        assert.deepEqual(
          res.headers.map((h) => h.text),
          expected.map((id) => textById.get(id)),
          `header texts of ${cell.id} at (${r},${c})`,
        );
      }
    }
  }
});

test('自动关联以整个覆盖范围为准，不随格内落点改变', () => {
  const nav = createTableNavigator(table);
  const expected = expectedHeaders['d7'];
  // d7 覆盖 (5,2)-(5,4)，三个落点的表头必须一致
  for (const c of [2, 3, 4]) {
    const res = must(nav.locate(5, c));
    assert.deepEqual(res.headers.map((h) => h.id), expected);
  }
});

test('移动到达目标格时表头同样按整个覆盖范围计算', () => {
  const nav = createTableNavigator(table);
  nav.locate(3, 2); // d1
  let res = must(nav.move('down')); // d4
  assert.deepEqual(res.headers.map((h) => h.id), expectedHeaders['d4']);
  res = must(nav.move('down')); // d7，落点 (5,2)
  assert.equal(res.cellId, 'd7');
  assert.deepEqual(res.headers.map((h) => h.id), expectedHeaders['d7']);
});

test('显式空关联与显式重复引用', () => {
  const nav = createTableNavigator(table);
  const d6 = must(nav.locate(4, 4));
  assert.deepEqual(d6.headers, []);
  const d5 = must(nav.locate(4, 3));
  // 保持给定次序、每个编号只保留首次出现、同文不同编号不合并
  assert.deepEqual(
    d5.headers.map((h) => h.id),
    ['ch4', 'ch1', 'ch3', 'rh2'],
  );
  assert.deepEqual(
    d5.headers.map((h) => h.text),
    ['DUP', 'CH1', 'DUP', 'RH2'],
  );
});
