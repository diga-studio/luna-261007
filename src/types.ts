/** 单元格类别 */
export type CellKind = "data" | "rowHeader" | "colHeader";

/** 输入单元格：坐标从 1 开始 */
export interface CellInput {
  /** 唯一编号 */
  readonly id: string;
  /** 文本内容 */
  readonly text: string;
  /** 类别：数据格 / 行表头 / 列表头 */
  readonly kind: CellKind;
  /** 起始行（1 起） */
  readonly row: number;
  /** 起始列（1 起） */
  readonly col: number;
  /** 行跨度，>= 1 */
  readonly rowSpan: number;
  /** 列跨度，>= 1 */
  readonly colSpan: number;
  /**
   * 显式关联表头编号序列。
   * 提供时（含空数组）只使用该序列；未提供（undefined）才自动关联。
   */
  readonly headerIds?: readonly string[];
}

/** 表格输入：已完成格式解析、不再修改 */
export interface TableInput {
  /** 总行数 */
  readonly rowCount: number;
  /** 总列数 */
  readonly colCount: number;
  /** 单元格集合 */
  readonly cells: readonly CellInput[];
}

/** 坐标（1 起） */
export interface Position {
  readonly row: number;
  readonly col: number;
}

export type Direction = "up" | "down" | "left" | "right";

/** 一次定位/移动的结果 */
export interface ReadResult {
  /** 是否落在被覆盖的坐标上；false 表示未移动（保持原位） */
  readonly moved: boolean;
  /** 目标单元格编号；未移动时为 null */
  readonly cellId: string | null;
  /** 目标单元格文本；未移动时为 null */
  readonly text: string | null;
  /** 实际落点（沿移动路径进入目标格的第一个坐标）；未移动时为 null */
  readonly position: Position | null;
  /** 有序表头文本序列 */
  readonly headers: readonly string[];
}
