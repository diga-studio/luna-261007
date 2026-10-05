import type { CellValue, ColumnType } from './types.js';
export interface ConvertResult {
    value: CellValue;
    /** false 表示非空值无法按列类型转换，须保留原文并告警。 */
    ok: boolean;
}
/**
 * 按判定类型转换单个单元格。
 * 空值输出 null；boolean/integer/float 输出相应 JavaScript 值；
 * 其它类型保持解码后的原文；无法转换的非空值保留原文并标记 ok=false。
 */
export declare function convertCell(raw: string, type: ColumnType): ConvertResult;
