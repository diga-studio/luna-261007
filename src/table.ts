import type { CellInput, CellKind, Position, TableInput } from "./types";

/** 规范化后的单元格（含派生的结束行列） */
export interface Cell {
  readonly id: string;
  readonly text: string;
  readonly kind: CellKind;
  readonly row: number;
  readonly col: number;
  readonly rowSpan: number;
  readonly colSpan: number;
  /** 结束行（含） */
  readonly endRow: number;
  /** 结束列（含） */
  readonly endCol: number;
  /** 显式表头序列；undefined 表示自动关联 */
  readonly headerIds: readonly string[] | undefined;
}

function normalize(input: CellInput): Cell {
  return {
    id: input.id,
    text: input.text,
    kind: input.kind,
    row: input.row,
    col: input.col,
    rowSpan: input.rowSpan,
    colSpan: input.colSpan,
    endRow: input.row + input.rowSpan - 1,
    endCol: input.col + input.colSpan - 1,
    headerIds: input.headerIds,
  };
}

/** 表格模型：持有单元格集合与坐标索引 */
export class TableModel {
  readonly rowCount: number;
  readonly colCount: number;

  private readonly cells: readonly Cell[];
  private readonly byId: Map<string, Cell>;
  /** 坐标索引：(row-1)*colCount + (col-1) -> Cell */
  private readonly grid: (Cell | null)[];

  constructor(input: TableInput) {
    this.rowCount = input.rowCount;
    this.colCount = input.colCount;
    this.cells = input.cells.map(normalize);
    this.byId = new Map();
    this.grid = new Array<Cell | null>(this.rowCount * this.colCount).fill(null);
    for (const cell of this.cells) {
      this.byId.set(cell.id, cell);
      for (let r = cell.row; r <= cell.endRow; r++) {
        for (let c = cell.col; c <= cell.endCol; c++) {
          this.grid[(r - 1) * this.colCount + (c - 1)] = cell;
        }
      }
    }
  }

  /** 坐标是否被某个单元格覆盖；越界返回 null */
  cellAt(pos: Position): Cell | null {
    if (pos.row < 1 || pos.row > this.rowCount || pos.col < 1 || pos.col > this.colCount) {
      return null;
    }
    return this.grid[(pos.row - 1) * this.colCount + (pos.col - 1)] ?? null;
  }

  /** 按编号取单元格 */
  cellById(id: string): Cell | null {
    return this.byId.get(id) ?? null;
  }

  /** 全部单元格 */
  allCells(): readonly Cell[] {
    return this.cells;
  }
}
