import type { Cell, TableModel } from "./table";
import type { Direction, Position } from "./types";

/** 移动结果：目标格与实际落点 */
export interface MoveHit {
  readonly cell: Cell;
  readonly position: Position;
}

/**
 * 从 from 出发沿 direction 移动：
 * 水平移动保持行号，竖直移动保持列号；
 * 从当前单元格对应边缘离开，跳过空洞，到达该方向最近的单元格；
 * 落点是沿移动路径进入目标格的第一个坐标。
 * 没有目标时返回 null。
 */
export function move(
  table: TableModel,
  from: Position,
  direction: Direction,
): MoveHit | null {
  const current = table.cellAt(from);
  switch (direction) {
    case "right": {
      const row = from.row;
      const startCol = current ? current.endCol + 1 : from.col + 1;
      for (let col = startCol; col <= table.colCount; col++) {
        const cell = table.cellAt({ row, col });
        if (cell) return { cell, position: { row, col } };
      }
      return null;
    }
    case "left": {
      const row = from.row;
      const startCol = current ? current.col - 1 : from.col - 1;
      for (let col = startCol; col >= 1; col--) {
        const cell = table.cellAt({ row, col });
        if (cell) return { cell, position: { row, col } };
      }
      return null;
    }
    case "down": {
      const col = from.col;
      const startRow = current ? current.endRow + 1 : from.row + 1;
      for (let row = startRow; row <= table.rowCount; row++) {
        const cell = table.cellAt({ row, col });
        if (cell) return { cell, position: { row, col } };
      }
      return null;
    }
    case "up": {
      const col = from.col;
      const startRow = current ? current.row - 1 : from.row - 1;
      for (let row = startRow; row >= 1; row--) {
        const cell = table.cellAt({ row, col });
        if (cell) return { cell, position: { row, col } };
      }
      return null;
    }
  }
}
