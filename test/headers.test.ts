import { describe, it } from "node:test";
import { deepEqual, equal } from "node:assert/strict";
import { TableReader } from "../src/index";
import type { CellInput, TableInput } from "../src/index";

/**
 * 5x5 多级表头小表（. 表示空洞）：
 *        c1      c2      c3      c4      c5
 * r1     .       相邻    |-- 年度 --|    总览
 * r2     .       .       季度    季度    总览
 * r3     北区    一店    D1      .       D4(显式空)
 * r4     北区    二店    |--- D2 ---|    .
 * r5     |-- 南区 --|    .       .       D3(显式重复)
 *
 * 两个列表头同文"季度"但编号不同；D2 横向跨两个季度列；
 * "相邻"与 D1 的列仅相邻不重叠，用于验证相邻不算重叠。
 */
const cells: CellInput[] = [
  { id: "h_adj", text: "相邻", kind: "colHeader", row: 1, col: 2, rowSpan: 1, colSpan: 1 },
  { id: "h_year", text: "年度", kind: "colHeader", row: 1, col: 3, rowSpan: 1, colSpan: 2 },
  { id: "h_all", text: "总览", kind: "colHeader", row: 1, col: 5, rowSpan: 2, colSpan: 1 },
  { id: "h_q1", text: "季度", kind: "colHeader", row: 2, col: 3, rowSpan: 1, colSpan: 1 },
  { id: "h_q2", text: "季度", kind: "colHeader", row: 2, col: 4, rowSpan: 1, colSpan: 1 },
  { id: "h_north", text: "北区", kind: "rowHeader", row: 3, col: 1, rowSpan: 2, colSpan: 1 },
  { id: "h_s1", text: "一店", kind: "rowHeader", row: 3, col: 2, rowSpan: 1, colSpan: 1 },
  { id: "h_s2", text: "二店", kind: "rowHeader", row: 4, col: 2, rowSpan: 1, colSpan: 1 },
  { id: "h_south", text: "南区", kind: "rowHeader", row: 5, col: 1, rowSpan: 1, colSpan: 2 },
  { id: "d1", text: "d1", kind: "data", row: 3, col: 3, rowSpan: 1, colSpan: 1 },
  { id: "d2", text: "d2", kind: "data", row: 4, col: 3, rowSpan: 1, colSpan: 2 },
  { id: "d3", text: "d3", kind: "data", row: 5, col: 5, rowSpan: 1, colSpan: 1,
    headerIds: ["h_q1", "h_north", "h_q1", "h_q2"] },
  { id: "d4", text: "d4", kind: "data", row: 3, col: 5, rowSpan: 1, colSpan: 1,
    headerIds: [] },
];

const table: TableInput = { rowCount: 5, colCount: 5, cells };

/** 每个单元格期望的有序表头文本 */
const expected: Record<string, string[]> = {
  h_adj: [],
  h_year: [],
  h_all: [],
  // 表头自身也按同样规则自动关联：上方重叠的列表头 + 左侧重叠的行表头
  h_q1: ["年度"],
  h_q2: ["年度"],
  h_north: [],
  h_s1: ["相邻", "北区"],
  h_s2: ["相邻", "北区"],
  h_south: ["相邻"],
  // 远处表头不因存在更近表头而省略；列表头按(行,列)、行表头按(列,行)升序
  d1: ["年度", "季度", "北区", "一店"],
  // 目标格跨两个季度列，两个同文列表头都保留
  d2: ["年度", "季度", "季度", "北区", "二店"],
  // 显式序列：保持给定次序、按编号去重、同文不同编号不合并
  d3: ["季度", "北区", "季度"],
  // 显式空序列：不报表头
  d4: [],
};

describe("有序表头", () => {
  it("全部已覆盖坐标返回的表头均符合规则", () => {
    const reader = new TableReader(table);
    let covered = 0;
    for (const cell of cells) {
      for (let r = cell.row; r < cell.row + cell.rowSpan; r++) {
        for (let c = cell.col; c < cell.col + cell.colSpan; c++) {
          const res = reader.locate({ row: r, col: c });
          equal(res.moved, true, `(${r},${c}) 应被覆盖`);
          equal(res.cellId, cell.id, `(${r},${c}) 应属于 ${cell.id}`);
          deepEqual(
            res.headers,
            expected[cell.id],
            `${cell.id} 在 (${r},${c}) 的表头`,
          );
          covered++;
        }
      }
    }
    equal(covered, 18);
  });

  it("自动关联不随合并格内落点改变", () => {
    const reader = new TableReader(table);
    // d2 覆盖 (4,3)-(4,4)，两个落点表头一致
    deepEqual(reader.locate({ row: 4, col: 3 }).headers, expected["d2"]);
    deepEqual(reader.locate({ row: 4, col: 4 }).headers, expected["d2"]);
    // 行表头 h_north 覆盖 (3,1)-(4,1)
    deepEqual(reader.locate({ row: 3, col: 1 }).headers, expected["h_north"]);
    deepEqual(reader.locate({ row: 4, col: 1 }).headers, expected["h_north"]);
  });

  it("移动返回的结果同样携带目标格的有序表头", () => {
    const reader = new TableReader(table);
    reader.locate({ row: 3, col: 3 }); // d1
    const res = reader.move("down"); // -> d2，落点 (4,3)
    equal(res.cellId, "d2");
    deepEqual(res.position, { row: 4, col: 3 });
    deepEqual(res.headers, expected["d2"]);
  });
});
