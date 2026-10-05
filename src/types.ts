/** 列类型。判型优先级即声明顺序（text 为兜底）。 */
export type ColumnType =
  | "boolean"
  | "integer"
  | "float"
  | "date"
  | "url"
  | "email"
  | "text";

/** 转换失败警告：定位到数据逻辑记录（0 起，不含表头）与列（0 起）。 */
export interface CsvImportWarning {
  /** 数据逻辑记录序号，从 0 开始（表头不计）。 */
  recordIndex: number;
  /** 列序号，从 0 开始。 */
  columnIndex: number;
  /** 无法按判定类型转换的原文。 */
  raw: string;
  /** 该列判定类型。 */
  columnType: ColumnType;
}

/** 一条数据记录的交付结果。 */
export interface CsvRow {
  /** 数据逻辑记录序号，从 0 开始（表头不计）。 */
  recordIndex: number;
  /** 按判定类型转换后的单元格；空值为 null，无法转换的非空单元格保留原文。 */
  cells: unknown[];
  /** 本行产生的警告。 */
  warnings: CsvImportWarning[];
}

/** 导入会话：表头立即可得，类型在第 100 条数据记录或流结束时交付，记录逐行产出。 */
export interface CsvImportSession {
  /** CSV 首条逻辑记录（表头），解码后的原文。 */
  readonly header: string[];
  /** 列类型判定结果；采样满 100 条或输入流结束时 resolve。 */
  readonly types: Promise<ColumnType[]>;
  /** 逐行交付的数据记录（含采样记录）。 */
  readonly rows: AsyncIterable<CsvRow>;
}

/** 输入：异步 UTF-8 字节流，块可落在任意字节边界，单块不超过 64 KiB。 */
export type CsvByteSource = AsyncIterable<Uint8Array>;
