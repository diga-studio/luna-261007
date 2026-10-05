import { ColumnInferer, convertCell } from "./infer.js";
import { CsvRecordParser } from "./parser.js";
import type {
  ColumnType,
  CsvByteSource,
  CsvImportSession,
  CsvImportWarning,
  CsvRow,
} from "./types.js";

/** 采样数据逻辑记录条数上限。 */
const SAMPLE_LIMIT = 100;

/**
 * 创建 CSV 导入会话。
 *
 * 返回前已读入表头并完成采样（满 100 条数据记录或输入结束），
 * 因此会话一旦返回即可交付列类型；采样记录与后续记录经 rows 逐行产出。
 * 类型确定后仅在调用方索取下一行时才继续读取输入，
 * 调用方暂停消费期间不会额外拉取（残留不足一个输入块，≤ 64 KiB）。
 */
export async function createImportSession(
  source: CsvByteSource,
): Promise<CsvImportSession> {
  const iter = source[Symbol.asyncIterator]();
  const decoder = new TextDecoder("utf-8");
  const parser = new CsvRecordParser();
  const queue: string[][] = [];
  let queueHead = 0;
  let eof = false;
  let bomChecked = false;

  function queueSize(): number {
    return queue.length - queueHead;
  }

  function takeRecord(): string[] | undefined {
    if (queueHead >= queue.length) return undefined;
    const record = queue[queueHead]!;
    queue[queueHead] = undefined as unknown as string[];
    queueHead++;
    if (queueHead >= 64 && queueHead * 2 >= queue.length) {
      queue.splice(0, queueHead);
      queueHead = 0;
    }
    return record;
  }

  // 读取输入直到队列中至少有一条完整记录，或输入结束。
  async function pullMore(): Promise<void> {
    while (queueSize() === 0 && !eof) {
      const next = await iter.next();
      if (next.done === true) {
        eof = true;
        const tail = decoder.decode();
        if (tail.length > 0) queue.push(...parser.push(tail));
        queue.push(...parser.end());
      } else {
        let text = decoder.decode(next.value, { stream: true });
        if (!bomChecked && text.length > 0) {
          bomChecked = true;
          if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
        }
        queue.push(...parser.push(text));
      }
    }
  }

  // 表头：首条逻辑记录，不参与判型。
  await pullMore();
  const header = takeRecord() ?? [];
  const columnCount = header.length;

  // 采样：最多 100 条数据记录；全空记录仍占名额。
  const inferers: ColumnInferer[] = [];
  for (let c = 0; c < columnCount; c++) inferers.push(new ColumnInferer());
  const sampleBuffer: string[][] = [];
  while (sampleBuffer.length < SAMPLE_LIMIT) {
    if (queueSize() === 0) await pullMore();
    const record = takeRecord();
    if (record === undefined) break;
    sampleBuffer.push(record);
    for (let c = 0; c < columnCount; c++) {
      const value = record[c] ?? "";
      if (value === "") inferers[c]!.addEmpty();
      else inferers[c]!.addSample(value);
    }
  }

  // 类型确定后不再调整。
  const decided: ColumnType[] = inferers.map((inf) => inf.decide());

  function convertRecord(record: string[], recordIndex: number): CsvRow {
    const cells: unknown[] = [];
    const warnings: CsvImportWarning[] = [];
    for (let c = 0; c < columnCount; c++) {
      const raw = record[c] ?? "";
      const result = convertCell(raw, decided[c]!);
      if (result.ok) {
        cells.push(result.value);
      } else {
        // 不能转换的非空单元格保留原文并告警，不丢行。
        cells.push(raw);
        warnings.push({
          recordIndex,
          columnIndex: c,
          raw,
          columnType: decided[c]!,
        });
      }
    }
    return { recordIndex, cells, warnings };
  }

  async function* rows(): AsyncGenerator<CsvRow> {
    let recordIndex = 0;
    for (const record of sampleBuffer) {
      yield convertRecord(record, recordIndex++);
    }
    sampleBuffer.length = 0; // 采样缓冲交付完毕即释放。
    for (;;) {
      if (queueSize() === 0) await pullMore();
      const record = takeRecord();
      if (record === undefined) return;
      yield convertRecord(record, recordIndex++);
    }
  }

  return {
    header,
    types: Promise.resolve(decided),
    rows: rows(),
  };
}
