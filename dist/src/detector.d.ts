import type { ColumnType } from './types.js';
/** 采样检测器：累计采样数据记录后判定每列类型。 */
export declare class TypeDetector {
    private readonly stats;
    constructor(columnCount: number);
    /** 累计一条采样记录。 */
    addRecord(cells: string[]): void;
    /** 采样结束（满 100 条或流结束），返回每列类型。 */
    finalize(): ColumnType[];
}
