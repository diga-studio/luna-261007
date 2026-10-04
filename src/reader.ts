import { headersFor } from "./headers";
import { move as moveCell } from "./navigation";
import { TableModel } from "./table";
import type { Cell } from "./table";
import type { Direction, Position, ReadResult, TableInput } from "./types";

const NOT_MOVED: ReadResult = {
  moved: false,
  cellId: null,
  text: null,
  position: null,
  headers: [],
};

function resultOf(table: TableModel, cell: Cell, position: Position): ReadResult {
  return {
    moved: true,
    cellId: cell.id,
    text: cell.text,
    position,
    headers: headersFor(table, cell).map((h) => h.text),
  };
}

/** 表格阅读器：持有单个阅读游标 */
export class TableReader {
  private readonly table: TableModel;
  private cursor: Position | null = null;

  constructor(input: TableInput) {
    this.table = new TableModel(input);
  }

  /** 当前游标坐标；尚未定位时为 null */
  get position(): Position | null {
    return this.cursor;
  }

  /** 定位到任意坐标；落在空洞或越界则不移动 */
  locate(pos: Position): ReadResult {
    const cell = this.table.cellAt(pos);
    if (!cell) return NOT_MOVED;
    this.cursor = { row: pos.row, col: pos.col };
    return resultOf(this.table, cell, this.cursor);
  }

  /** 从当前坐标向指定方向移动；未定位或无目标时保持原位 */
  move(direction: Direction): ReadResult {
    if (!this.cursor) return NOT_MOVED;
    const hit = moveCell(this.table, this.cursor, direction);
    if (!hit) return NOT_MOVED;
    this.cursor = hit.position;
    return resultOf(this.table, hit.cell, hit.position);
  }
}
