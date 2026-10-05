import type { CsvByteSource, CsvImportSession, CsvRow } from "../src/index.js";
import { createImportSession } from "../src/index.js";

export function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** 把字节数组按给定尺寸切块（模拟任意字节边界分块）。 */
export function chunkBytes(data: Uint8Array, size: number): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < data.length; i += size) {
    chunks.push(data.subarray(i, Math.min(i + size, data.length)));
  }
  return chunks;
}

/** 用可复现的伪随机序列把字节数组切成随机大小的块。 */
export function chunkRandom(data: Uint8Array, seed: number): Uint8Array[] {
  let state = seed >>> 0 || 1;
  const rand = (): number => {
    state = (state * 1103515245 + 12345) >>> 0;
    return state;
  };
  const chunks: Uint8Array[] = [];
  let i = 0;
  while (i < data.length) {
    const size = 1 + (rand() % 97);
    chunks.push(data.subarray(i, Math.min(i + size, data.length)));
    i += size;
  }
  return chunks;
}

export async function* sourceOf(chunks: Uint8Array[]): CsvByteSource {
  for (const c of chunks) yield c;
}

export interface Collected {
  header: string[];
  types: string[];
  rows: CsvRow[];
}

/** 创建会话并收集全部输出，便于断言。 */
export async function collect(csv: string, chunkSize: number): Promise<Collected> {
  const data = encode(csv);
  const session = await createImportSession(sourceOf(chunkBytes(data, chunkSize)));
  return collectSession(session);
}

export async function collectSession(session: CsvImportSession): Promise<Collected> {
  const rows: CsvRow[] = [];
  for await (const row of session.rows) rows.push(row);
  return { header: session.header, types: await session.types, rows };
}
