import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importCsv } from '../src/index.js';
import type { ImportEvent, MetaEvent, RecordEvent } from '../src/index.js';
import { makeCsv } from './helpers.js';

const KiB = 1024;

/** 记录每次拉取字节数的异步源。 */
function countedSource(chunks: Uint8Array[]) {
  const state = { pulled: 0 };
  const source = (async function* () {
    for (const c of chunks) {
      state.pulled += c.length;
      yield c;
    }
  })();
  return { source, state };
}

function splitChunks(data: Uint8Array, size: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < data.length; i += size) out.push(data.subarray(i, i + size));
  return out;
}

test('获得第 100 条完整数据记录后即交付 meta 与采样记录，无需后续输入', async () => {
  const header = ['flag', 'note'];
  const rows = Array.from({ length: 150 }, (_, i) => [
    i % 2 === 0 ? 'true' : 'false',
    `row${i}`,
  ]);
  const csv = makeCsv(header, rows);
  const bytes = new TextEncoder().encode(csv);
  // 找到第 100 条数据记录结束（第 101 个换行）后的字节偏移。
  let nl = 0;
  let cut = -1;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x0a && ++nl === 101) {
      cut = i + 1;
      break;
    }
  }
  assert.ok(cut > 0);

  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const { source, state } = countedSource([
    bytes.subarray(0, cut),
    bytes.subarray(cut),
  ]);
  const gated = (async function* () {
    const it = source[Symbol.asyncIterator]();
    const first = await it.next();
    yield first.value as Uint8Array;
    await gate; // 后续输入暂停到达
    let next = await it.next();
    while (!next.done) {
      yield next.value;
      next = await it.next();
    }
  })();

  const events: ImportEvent[] = [];
  const consumer = (async () => {
    for await (const e of importCsv(gated)) events.push(e);
  })();

  // 等待 meta + 100 条采样记录交付。
  await new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const check = () => {
      if (events.length >= 101) return resolve();
      if (Date.now() > deadline) return reject(new Error('未及时交付'));
      setImmediate(check);
    };
    check();
  });

  const meta = events[0] as MetaEvent;
  assert.equal(meta.kind, 'meta');
  assert.deepEqual(meta.types, ['boolean', 'text']);
  assert.equal(events.filter((e) => e.kind === 'record').length, 100);
  // 暂停期间没有多读：只拉取了第一块。
  assert.equal(state.pulled, cut);

  release();
  await consumer;
  assert.equal(events.filter((e) => e.kind === 'record').length, 150);
});

test('类型确定后调用方暂停消费，累计额外读取不超过 64 KiB', async () => {
  const header = ['n', 't'];
  const rows = Array.from({ length: 300 }, (_, i) => [
    String(i),
    `body-${i}-` + 'y'.repeat(1800),
  ]);
  const csv = makeCsv(header, rows);
  const bytes = new TextEncoder().encode(csv);

  // 每条数据记录结束位置的字节偏移（含换行）。
  const boundaries: number[] = [];
  let nl = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x0a) {
      nl++;
      if (nl >= 2) boundaries.push(i + 1); // 跳过表头
    }
  }

  const { source, state } = countedSource(splitChunks(bytes, 64 * KiB));
  let deliveredOffset = 0;
  let maxExtra = 0;
  for await (const e of importCsv(source)) {
    if (e.kind === 'meta') {
      deliveredOffset = boundaries[99]!; // 采样 100 条
    } else {
      // 采样阶段读入的前 100 条属于判型必需，不计入额外读取。
      deliveredOffset = Math.max(
        deliveredOffset,
        boundaries[(e as RecordEvent).index - 1]!,
      );
    }
    maxExtra = Math.max(maxExtra, state.pulled - deliveredOffset);
    // 慢速消费
    await new Promise((r) => setTimeout(r, 0));
  }
  assert.ok(
    maxExtra <= 64 * KiB,
    `额外读取 ${maxExtra} 字节，超过 64 KiB`,
  );
});

test('满规模文件慢速消费：额外峰值内存不超过 96 MiB', async () => {
  const RECORDS = 1000;
  const COLS = 50;
  const CELL = 4 * KiB;
  const textCols = 40;

  const header = Array.from({ length: COLS }, (_, j) => `c${j}`).join(',') + '\n';
  const headerBytes = new TextEncoder().encode(header);

  // 逐块生成，避免在测试侧持有整个文件。
  const source = (async function* (): AsyncIterable<Uint8Array> {
    yield headerBytes;
    const encoder = new TextEncoder();
    for (let r = 0; r < RECORDS; r++) {
      const cells: string[] = [];
      for (let c = 0; c < COLS; c++) {
        if (c < textCols) {
          cells.push('x'.repeat(CELL - 8) + String(r).padStart(8, '0'));
        } else if (c < textCols + 5) {
          cells.push(r % 2 === 0 ? 'true' : 'false');
        } else {
          cells.push(String(r * 7 + c));
        }
      }
      const line = cells.join(',') + '\n';
      const buf = encoder.encode(line);
      // 以不超过 64 KiB 的块交付。
      for (let i = 0; i < buf.length; i += 64 * KiB) {
        yield buf.subarray(i, i + 64 * KiB);
      }
    }
  })();

  global.gc!();
  const baseline = process.memoryUsage().heapUsed;
  let peak = baseline;
  let count = 0;
  let meta: MetaEvent | null = null;
  for await (const e of importCsv(source)) {
    if (e.kind === 'meta') {
      meta = e;
    } else {
      count++;
      // 不保存输出，模拟调用方即取即用。
      if (count % 16 === 0) await new Promise((r) => setImmediate(r));
    }
    const used = process.memoryUsage().heapUsed;
    if (used > peak) peak = used;
  }
  global.gc!();

  assert.ok(meta !== null);
  const types = (meta as MetaEvent).types;
  assert.deepEqual(types.slice(0, textCols), new Array(textCols).fill('text'));
  assert.deepEqual(types.slice(textCols, textCols + 5), new Array(5).fill('boolean'));
  assert.deepEqual(types.slice(textCols + 5), new Array(5).fill('integer'));
  assert.equal(count, RECORDS);

  const extraMiB = (peak - baseline) / (1024 * 1024);
  assert.ok(extraMiB <= 96, `额外峰值内存 ${extraMiB.toFixed(1)} MiB 超过 96 MiB`);
});
