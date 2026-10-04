import type { Cell, TableModel } from "./table";

/** 区间 [aStart,aEnd] 与 [bStart,bEnd] 是否重叠（仅相邻不算重叠） */
function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart <= bEnd && bStart <= aEnd;
}

/** 显式序列：保持给定次序，每个编号只保留首次出现，不递归展开 */
function explicitHeaders(table: TableModel, ids: readonly string[]): Cell[] {
  const seen = new Set<string>();
  const result: Cell[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const cell = table.cellById(id);
    if (cell) result.push(cell);
  }
  return result;
}

/** 自动关联：以目标格的整个覆盖范围为准 */
function autoHeaders(table: TableModel, target: Cell): Cell[] {
  const colHeaders: Cell[] = [];
  const rowHeaders: Cell[] = [];
  for (const cell of table.allCells()) {
    if (cell === target) continue;
    if (
      cell.kind === "colHeader" &&
      cell.endRow < target.row &&
      overlaps(cell.col, cell.endCol, target.col, target.endCol)
    ) {
      colHeaders.push(cell);
    } else if (
      cell.kind === "rowHeader" &&
      cell.endCol < target.col &&
      overlaps(cell.row, cell.endRow, target.row, target.endRow)
    ) {
      rowHeaders.push(cell);
    }
  }
  colHeaders.sort((a, b) => a.row - b.row || a.col - b.col);
  rowHeaders.sort((a, b) => a.col - b.col || a.row - b.row);
  return [...colHeaders, ...rowHeaders];
}

/**
 * 计算目标格的有序表头序列。
 * 显式序列优先（去重保序、不递归展开）；未提供时自动关联：
 * 先列区间重叠且整体在目标上方的列表头（按起始行、起始列升序），
 * 再行区间重叠且整体在目标左侧的行表头（按起始列、起始行升序）。
 */
export function headersFor(table: TableModel, target: Cell): readonly Cell[] {
  if (target.headerIds !== undefined) {
    return explicitHeaders(table, target.headerIds);
  }
  return autoHeaders(table, target);
}
