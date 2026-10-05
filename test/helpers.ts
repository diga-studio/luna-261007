import { importCsv } from '../src/index.js';
import type { ImportEvent, MetaEvent, RecordEvent } from '../src/index.js';

/** 把字节串按固定块大小切成异步流。 */
export async function* chunkBytes(
  data: Uint8Array,
  size: number,
): AsyncIterable<Uint8Array> {
  for (let i = 0; i < data.length; i += size) {
    yield data.subarray(i, Math.min(i + size, data.length));
  }
}

export async function collect(
  events: AsyncGenerator<ImportEvent>,
): Promise<ImportEvent[]> {
  const out: ImportEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

/** 以指定字节块大小跑完整导入，返回全部事件。 */
export async function runImport(
  csv: string,
  chunkSize: number,
): Promise<ImportEvent[]> {
  return collect(importCsv(chunkBytes(new TextEncoder().encode(csv), chunkSize)));
}

export function metaOf(events: ImportEvent[]): MetaEvent {
  const meta = events.find((e) => e.kind === 'meta');
  if (!meta) throw new Error('missing meta event');
  return meta as MetaEvent;
}

export function recordsOf(events: ImportEvent[]): RecordEvent[] {
  return events.filter((e) => e.kind === 'record') as RecordEvent[];
}

/** 生成 n 条数据记录的 CSV（header + n 行），每行 cols 列。 */
export function makeCsv(
  header: string[],
  rows: string[][],
  newline = '\n',
): string {
  const q = (s: string) =>
    /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  const lines = [header, ...rows].map((r) => r.map(q).join(','));
  return lines.join(newline) + newline;
}
