/** 单元格类别：数据格、行表头、列表头。 */
export type CellKind = 'data' | 'row-header' | 'col-header';

/** 输入单元格：坐标从 1 开始，覆盖连续矩形。 */
export interface CellInput {
  /** 唯一编号 */
  readonly id: string;
  /** 文本内容 */
  readonly text: string;
  /** 起始行（1 起） */
  readonly row: number;
  /** 起始列（1 起） */
  readonly col: number;
  /** 行跨度 */
  readonly rowSpan: number;
  /** 列跨度 */
  readonly colSpan: number;
  /** 单元格类别 */
  readonly kind: CellKind;
  /**
   * 显式关联表头编号序列（可选）。
   * 提供时只使用该序列；空数组表示不报表头；未提供才自动关联。
   */
  readonly headers?: readonly string[];
}

/** 输入表格：已完成格式解析、不再修改。 */
export interface TableInput {
  readonly rowCount: number;
  readonly colCount: number;
  readonly cells: readonly CellInput[];
}

/** 阅读游标位置（实际落点坐标，1 起）。 */
export interface Position {
  readonly row: number;
  readonly col: number;
}

export type Direction = 'up' | 'down' | 'left' | 'right';

/** 有序表头中的一项。 */
export interface HeaderInfo {
  readonly id: string;
  readonly text: string;
}

/** 一次定位或移动的结果。 */
export interface ReadResult {
  /** 落点所在单元格编号 */
  readonly cellId: string;
  /** 单元格文本 */
  readonly text: string;
  /** 实际落点行（1 起） */
  readonly row: number;
  /** 实际落点列（1 起） */
  readonly col: number;
  /** 有序表头（先列表头后行表头） */
  readonly headers: readonly HeaderInfo[];
}

/** 单游标表格导航器。 */
export interface TableNavigator {
  /** 当前游标位置；尚未定位时为 null。 */
  readonly position: Position | null;
  /**
   * 定位到任意坐标。坐标被覆盖则移动游标并返回阅读结果；
   * 未被覆盖（空洞或越界）则保持原位并返回 null。
   */
  locate(row: number, col: number): ReadResult | null;
  /**
   * 从当前坐标向指定方向移动。水平移动保持行号，竖直移动保持列号；
   * 跳过空洞，到达该方向最近的单元格；落点为沿路径进入目标格的第一个坐标。
   * 没有目标或游标未定位时保持原位并返回 null。
   */
  move(direction: Direction): ReadResult | null;
}

/** 由表格输入创建导航器。 */
export declare function createTableNavigator(table: TableInput): TableNavigator;
