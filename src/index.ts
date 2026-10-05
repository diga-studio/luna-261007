import { CsvParser } from './csvParser.js';
import { TypeDetector } from './detector.js';
import { convertCell } from './convert.js';
import type {
  CellValue,
  ColumnType,
  CsvWarning,
  ImportEvent,
  RecordEvent,
} from './types.js';

export type {
  CellValue,
  ColumnType,
  CsvWarning,
  ImportEvent,
  MetaEvent,
  RecordEvent,
} from './types.js';

/** 采样数据记录条数上限。 */
const SAMPLE_LIMIT = 100;

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
export async function* importCsv(
  source: AsyncIterable<Uint8Array>,
): AsyncGenerator<ImportEvent> {
  const decoder = new TextDecoder('utf-8'); // 默认去除流首 BOM
  const parser = new CsvParser();
  const eventQueue: ImportEvent[] = [];

  let header: string[] | null = null;
  let detector: TypeDetector | null = null;
  let types: ColumnType[] | null = null;
  const sampled: string[][] = [];
  let recordIndex = 0;

  const makeRecordEvent = (cells: string[]): RecordEvent => {
    recordIndex++;
    const out: CellValue[] = new Array<CellValue>(cells.length);
    const warnings: CsvWarning[] = [];
    for (let i = 0; i < cells.length; i++) {
      const raw = cells[i]!;
      const type = types![i]!;
      const result = convertCell(raw, type);
      out[i] = result.value;
      if (!result.ok) {
        warnings.push({
          record: recordIndex,
          column: i + 1,
          expectedType: type,
          value: raw,
        });
      }
    }
    return { kind: 'record', index: recordIndex, cells: out, warnings };
  };

  const closeSampling = (): void => {
    types = detector!.finalize();
    eventQueue.push({ kind: 'meta', header: header!, types });
    for (const cells of sampled) {
      eventQueue.push(makeRecordEvent(cells));
    }
    sampled.length = 0;
  };

  const ingestRecord = (record: string[]): void => {
    if (header === null) {
      header = record;
      detector = new TypeDetector(record.length);
      return;
    }
    if (types === null) {
      detector!.addRecord(record);
      sampled.push(record);
      if (sampled.length === SAMPLE_LIMIT) closeSampling();
      return;
    }
    eventQueue.push(makeRecordEvent(record));
  };

  for await (const chunk of source) {
    for (const record of parser.push(decoder.decode(chunk, { stream: true }))) {
      ingestRecord(record);
    }
    while (eventQueue.length > 0) {
      yield eventQueue.shift()!;
    }
  }

  // 流结束：冲刷解码器与解析器中的残余数据。
  const tail = decoder.decode();
  for (const record of parser.push(tail)) ingestRecord(record);
  for (const record of parser.end()) ingestRecord(record);

  // 不足 100 条采样记录：此时才判定列类型并交付。
  if (header !== null && types === null) closeSampling();

  while (eventQueue.length > 0) {
    yield eventQueue.shift()!;
  }
}
