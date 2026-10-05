import type { ImportEvent } from './types.js';
export type { CellValue, ColumnType, CsvWarning, ImportEvent, MetaEvent, RecordEvent, } from './types.js';
/**
 * CSV 导入入口：输入异步 UTF-8 字节流，
 * 以异步事件流形式先交付 meta（表头与列类型），再逐行交付记录。
 *
 * - 首条逻辑记录为表头，不参与判型。
 * - 采样前 100 条数据记录判型；满 100 条立即交付 meta 与采样记录，
 *   不足 100 条则在流结束后交付。
 * - 仅在调用方继续消费时才拉取后续输入块，暂停消费期间
 *   额外读取不超过一个输入块（<= 64 KiB）。
 */
export declare function importCsv(source: AsyncIterable<Uint8Array>): AsyncGenerator<ImportEvent>;
