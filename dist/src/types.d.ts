/** 判型结果列类型，按优先级排列。 */
export type ColumnType = 'boolean' | 'integer' | 'float' | 'date' | 'url' | 'email' | 'text';
/** 转换失败警告：定位数据逻辑记录与列。 */
export interface CsvWarning {
    /** 数据逻辑记录序号（表头之后从 1 开始）。 */
    record: number;
    /** 列序号（从 1 开始）。 */
    column: number;
    /** 列的判定类型。 */
    expectedType: ColumnType;
    /** 无法转换的原文。 */
    value: string;
}
/** 转换后的单元格值。 */
export type CellValue = string | number | boolean | null;
/** 元数据事件：列类型确定后交付一次。 */
export interface MetaEvent {
    kind: 'meta';
    /** 表头（首条逻辑记录，解码后原文）。 */
    header: string[];
    /** 每列判定类型。 */
    types: ColumnType[];
}
/** 数据记录事件。 */
export interface RecordEvent {
    kind: 'record';
    /** 数据逻辑记录序号（表头之后从 1 开始）。 */
    index: number;
    /** 转换后的单元格。 */
    cells: CellValue[];
    /** 本记录产生的警告。 */
    warnings: CsvWarning[];
}
export type ImportEvent = MetaEvent | RecordEvent;
