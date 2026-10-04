import { describe, it } from "node:test";
import { deepEqual, equal } from "node:assert/strict";
import { TableReader } from "../src/index";
import type { TableInput } from "../src/index";

/**
 * 6x6 表格，含合并格与空洞：
 *   A: data (2,2) 2x2   B: data (2,5) 1x2
 *   C: data (5,3) 1x1   D: data (4,2) 2x1   E: data (5,5) 1x1
 */
const table: TableInput = {
  rowCount: 6,
  colCount: 6,
  cells: [
    { id: "A", text: "a", kind: "data", row: 2, col: 2, rowSpan: 2, colSpan: 2 },
    { id: "B", text: "b", kind: "data", row: 2, col: 5, rowSpan: 1, colSpan: 2 },
    { id: "C", text: "c", kind: "data", row: 5, col: 3, rowSpan: 1, colSpan: 1 },
    { id: "D", text: "d", kind: "data", row: 4, col: 2, rowSpan: 2, colSpan: 1 },
    { id: "E", text: "e", kind: "data", row: 5, col: 5, rowSpan: 1, colSpan: 1 },
  ],
};

describe("定位", () => {
  it("定位到合并格内部，落点即所点坐标", () => {
    const r = new TableReader(table);
    const res = r.locate({ row: 3, col: 3 });
    equal(res.moved, true);
    equal(res.cellId, "A");
    equal(res.text, "a");
    deepEqual(res.position, { row: 3, col: 3 });
    deepEqual(r.position, { row: 3, col: 3 });
  });

  it("定位到空洞或越界时不移动", () => {
    const r = new TableReader(table);
    equal(r.locate({ row: 1, col: 1 }).moved, false);
    equal(r.position, null);
    r.locate({ row: 5, col: 5 });
    equal(r.locate({ row: 4, col: 4 }).moved, false);
    equal(r.locate({ row: 9, col: 9 }).moved, false);
    deepEqual(r.position, { row: 5, col: 5 });
  });

  it("未定位时移动保持原位", () => {
    const r = new TableReader(table);
    equal(r.move("down").moved, false);
    equal(r.position, null);
  });
});

describe("移动", () => {
  it("竖直移动保持列号，跨空洞到达最近单元格", () => {
    const r = new TableReader(table);
    r.locate({ row: 3, col: 3 }); // A 内部
    const res = r.move("down"); // 从 A 下边缘离开，跳过 (4,3) 空洞
    equal(res.cellId, "C");
    deepEqual(res.position, { row: 5, col: 3 });
  });

  it("跨空洞移动后再转向，水平移动保持行号", () => {
    const r = new TableReader(table);
    r.locate({ row: 3, col: 3 });
    r.move("down"); // -> C (5,3)
    const res = r.move("left"); // 行 5 上向左，D 覆盖 (5,2)
    equal(res.cellId, "D");
    deepEqual(res.position, { row: 5, col: 2 });
  });

  it("落点是沿路径进入目标格的第一个坐标，而非左上角", () => {
    const r = new TableReader(table);
    r.locate({ row: 5, col: 2 }); // D 下端
    const res = r.move("up"); // 从 D 上边缘 (3,2) 进入 A
    equal(res.cellId, "A");
    deepEqual(res.position, { row: 3, col: 2 }); // 不是 A 的左上角 (2,2)
  });

  it("从合并格内部按对应边缘离开", () => {
    const r = new TableReader(table);
    r.locate({ row: 3, col: 3 }); // A 内部
    equal(r.move("up").moved, false); // A 上边缘之外 (1,3) 是空洞
    deepEqual(r.position, { row: 3, col: 3 });
    equal(r.move("left").moved, false); // (3,1) 是空洞
    deepEqual(r.position, { row: 3, col: 3 });
  });

  it("水平移动跳过空洞到达最近单元格", () => {
    const r = new TableReader(table);
    r.locate({ row: 2, col: 2 }); // A
    const res = r.move("right"); // 跳过 (2,4) 空洞
    equal(res.cellId, "B");
    deepEqual(res.position, { row: 2, col: 5 }); // 进入 B 的第一个坐标
  });

  it("从合并格非左上角位置出发仍按整格边缘离开", () => {
    const r = new TableReader(table);
    r.locate({ row: 2, col: 6 }); // B 内部右端
    const res = r.move("left"); // 从 B 左边缘离开，跳过 (2,4) 空洞进入 A
    equal(res.cellId, "A");
    deepEqual(res.position, { row: 2, col: 3 });
  });

  it("向下跨多个空洞后继续转向", () => {
    const r = new TableReader(table);
    r.locate({ row: 2, col: 5 }); // B
    const down = r.move("down"); // 跳过 (3,5)(4,5) 空洞
    equal(down.cellId, "E");
    deepEqual(down.position, { row: 5, col: 5 });
    const left = r.move("left"); // 行 5 上跳过 (5,4) 空洞
    equal(left.cellId, "C");
    deepEqual(left.position, { row: 5, col: 3 });
  });

  it("到达边界无目标时保持原位", () => {
    const r = new TableReader(table);
    r.locate({ row: 2, col: 5 }); // B
    equal(r.move("right").moved, false); // 右侧到表尾
    deepEqual(r.position, { row: 2, col: 5 });
    equal(r.move("up").moved, false); // 上方到表顶
    deepEqual(r.position, { row: 2, col: 5 });
  });
});
