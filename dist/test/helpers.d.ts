import type { ImportEvent, MetaEvent, RecordEvent } from '../src/index.js';
/** 把字节串按固定块大小切成异步流。 */
export declare function chunkBytes(data: Uint8Array, size: number): AsyncIterable<Uint8Array>;
export declare function collect(events: AsyncGenerator<ImportEvent>): Promise<ImportEvent[]>;
/** 以指定字节块大小跑完整导入，返回全部事件。 */
export declare function runImport(csv: string, chunkSize: number): Promise<ImportEvent[]>;
export declare function metaOf(events: ImportEvent[]): MetaEvent;
export declare function recordsOf(events: ImportEvent[]): RecordEvent[];
/** 生成 n 条数据记录的 CSV（header + n 行），每行 cols 列。 */
export declare function makeCsv(header: string[], rows: string[][], newline?: string): string;
