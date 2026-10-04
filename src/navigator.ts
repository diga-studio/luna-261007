import type {
  Direction,
  Position,
  ReadResult,
  TableInput,
  TableNavigator,
} from './types';
import { buildModel, type Cell, type Model } from './model';
import { computeHeaders } from './headers';

class NavigatorImpl implements TableNavigator {
  private readonly model: Model;
  private current: Position | null = null;

  constructor(table: TableInput) {
    this.model = buildModel(table);
  }

  get position(): Position | null {
    return this.current === null ? null : { ...this.current };
  }

  locate(row: number, col: number): ReadResult | null {
    const cell = this.cellAt(row, col);
    if (cell === undefined) {
      return null;
    }
    return this.land(cell, row, col);
  }

  move(direction: Direction): ReadResult | null {
    if (this.current === null) {
      return null;
    }
    const { row, col } = this.current;
    const origin = this.model.grid[row][col];
    if (origin === undefined) {
      return null;
    }
    switch (direction) {
      case 'right':
        return this.scan(row, origin.colEnd + 1, 0, 1);
      case 'left':
        return this.scan(row, origin.colStart - 1, 0, -1);
      case 'down':
        return this.scan(origin.rowEnd + 1, col, 1, 0);
      case 'up':
        return this.scan(origin.rowStart - 1, col, -1, 0);
    }
  }

  /**
   * 从 (row, col) 起沿 (dRow, dCol) 步进，保持垂直方向坐标不变，
   * 跳过空洞，落点为路径上第一个被覆盖的坐标。
   */
  private scan(row: number, col: number, dRow: number, dCol: number): ReadResult | null {
    let r = row;
    let c = col;
    while (r >= 1 && r <= this.model.rowCount && c >= 1 && c <= this.model.colCount) {
      const cell = this.model.grid[r][c];
      if (cell !== undefined) {
        return this.land(cell, r, c);
      }
      r += dRow;
      c += dCol;
    }
    return null;
  }

  private cellAt(row: number, col: number): Cell | undefined {
    if (row < 1 || row > this.model.rowCount || col < 1 || col > this.model.colCount) {
      return undefined;
    }
    return this.model.grid[row][col];
  }

  private land(cell: Cell, row: number, col: number): ReadResult {
    this.current = { row, col };
    return {
      cellId: cell.id,
      text: cell.text,
      row,
      col,
      headers: computeHeaders(this.model, cell),
    };
  }
}

export function createTableNavigator(table: TableInput): TableNavigator {
  return new NavigatorImpl(table);
}
