import type { CellKind, TableInput } from './types';

/** 归一化后的单元格，行列区间为闭区间（1 起）。 */
export interface Cell {
  readonly id: string;
  readonly text: string;
  readonly kind: CellKind;
  readonly rowStart: number;
  readonly rowEnd: number;
  readonly colStart: number;
  readonly colEnd: number;
  /** 显式表头序列；undefined 表示未提供，需自动关联。 */
  readonly explicitHeaders: readonly string[] | undefined;
}

export interface Model {
  readonly rowCount: number;
  readonly colCount: number;
  readonly cells: readonly Cell[];
  readonly byId: ReadonlyMap<string, Cell>;
  /**
   * 覆盖索引：grid[row][col] 为覆盖该坐标的单元格，未覆盖为 undefined。
   * 下标 1..rowCount / 1..colCount 有效，第 0 行/列留空。
   */
  readonly grid: ReadonlyArray<ReadonlyArray<Cell | undefined>>;
}

export function buildModel(table: TableInput): Model {
  const cells: Cell[] = table.cells.map((c) => ({
    id: c.id,
    text: c.text,
    kind: c.kind,
    rowStart: c.row,
    rowEnd: c.row + c.rowSpan - 1,
    colStart: c.col,
    colEnd: c.col + c.colSpan - 1,
    explicitHeaders: c.headers,
  }));
  const byId = new Map<string, Cell>();
  for (const cell of cells) {
    byId.set(cell.id, cell);
  }
  const grid: Array<Array<Cell | undefined>> = [];
  for (let r = 0; r <= table.rowCount; r++) {
    grid.push(new Array<Cell | undefined>(table.colCount + 1).fill(undefined));
  }
  for (const cell of cells) {
    for (let r = cell.rowStart; r <= cell.rowEnd; r++) {
      for (let c = cell.colStart; c <= cell.colEnd; c++) {
        grid[r][c] = cell;
      }
    }
  }
  return {
    rowCount: table.rowCount,
    colCount: table.colCount,
    cells,
    byId,
    grid,
  };
}
