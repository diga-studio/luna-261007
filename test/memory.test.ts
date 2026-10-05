import assert from 'node:assert/strict';
import test from 'node:test';
import { TextEncoder } from 'node:util';
import { StlAnalyzer } from '../src/index.js';
import { mulberry32 } from './helpers.js';

const gc = (globalThis as { gc?: () => void }).gc;

function heapUsed(): number {
  gc?.();
  gc?.();
  return process.memoryUsage().heapUsed;
}

/**
 * 惰性生成 ASCII STL：≥64 MiB 的 UTF-8 名称 + 大量重复三角形。
 * 永不拼出完整输入；chunk 大小由固定种子 PRNG 决定。
 */
function* bigAsciiChunks(): Generator<Uint8Array> {
  const enc = new TextEncoder();
  const nameUnit = enc.encode('名'.repeat(1024)); // 3 KiB，合法多字节 UTF-8
  const nameRepeats = Math.ceil((64 * 1024 * 1024) / nameUnit.length);
  const facet = enc.encode(
    'facet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 25.4 0 0\nvertex 0 25.4 0\nendloop\nendfacet\n',
  );
  const facetCount = 100_000;
  const tail = enc.encode('endsolid 名\n');

  // 逻辑字节流：'solid ' + nameUnit*nameRepeats + '\n' + facet*facetCount + tail
  const segments: { bytes: Uint8Array; repeats: number }[] = [
    { bytes: enc.encode('solid '), repeats: 1 },
    { bytes: nameUnit, repeats: nameRepeats },
    { bytes: enc.encode('\n'), repeats: 1 },
    { bytes: facet, repeats: facetCount },
    { bytes: tail, repeats: 1 },
  ];
  const rand = mulberry32(0xc0ffee);
  let pending: Uint8Array = new Uint8Array(0);
  const emit = function* (out: Uint8Array, fill: number) {
    let start = 0;
    while (start < fill) {
      const n = 1 + Math.floor(rand() * 4095);
      yield out.subarray(start, Math.min(start + n, fill));
      start += n;
    }
  };
  for (const seg of segments) {
    for (let r = 0; r < seg.repeats; r += 1) {
      let piece: Uint8Array = seg.bytes;
      if (pending.length > 0) {
        const joined = new Uint8Array(pending.length + piece.length);
        joined.set(pending, 0);
        joined.set(piece, pending.length);
        piece = joined;
        pending = new Uint8Array(0);
      }
      // 按随机大小切块；不足 4KB 的小段与下一段合并，避免过多微 chunk
      if (piece.length < 4096 && seg.repeats > 1) {
        pending = piece;
        continue;
      }
      yield* emit(piece, piece.length);
    }
  }
  if (pending.length > 0) yield pending;
}

/** 惰性生成二进制 STL：1_000_000 条记录（约 50 MiB），不预拼完整输入。 */
function* bigBinaryChunks(): Generator<Uint8Array> {
  const triCount = 1_000_000;
  const header = new Uint8Array(84);
  new DataView(header.buffer).setUint32(80, triCount, true);
  yield header;
  const record = new Uint8Array(50);
  const view = new DataView(record.buffer);
  const comps = [0, 0, 1, 0, 0, 0, 25.4, 0, 0, 0, 25.4, 0];
  comps.forEach((v, i) => view.setFloat32(i * 4, v, true));
  const batch = new Uint8Array(50 * 4096);
  for (let i = 0; i < 4096; i += 1) batch.set(record, i * 50);
  const fullBatches = Math.floor(triCount / 4096);
  for (let i = 0; i < fullBatches; i += 1) yield batch;
  const rest = triCount % 4096;
  if (rest > 0) yield batch.subarray(0, rest * 50);
}

test('内存有界：64 MiB 名称 + 10 万 facet 的 ASCII 流', () => {
  const analyzer = new StlAnalyzer();
  // 先热身一轮小输入，排除一次性运行时开销
  const warm = new StlAnalyzer();
  warm.push(new TextEncoder().encode('solid w\nendsolid\n'));
  warm.finish();

  const before = heapUsed();
  let total = 0;
  for (const chunk of bigAsciiChunks()) {
    total += chunk.length;
    analyzer.push(chunk);
  }
  const meta = analyzer.finish();
  const after = heapUsed();

  assert.ok(total > 64 * 1024 * 1024, `input too small: ${total}`);
  assert.equal(meta.format, 'ascii');
  assert.equal(meta.triangleCount, 100_000);
  assert.ok(meta.boundingBox);
  assert.ok(Math.abs(meta.boundingBox!.max.x - 1) < 1e-9);
  const growthMiB = (after - before) / (1024 * 1024);
  assert.ok(
    growthMiB < 32,
    `heap grew ${growthMiB.toFixed(1)} MiB while streaming ${(total / 1024 / 1024).toFixed(0)} MiB`,
  );
});

test('内存有界：100 万条记录的二进制流', () => {
  const warm = new StlAnalyzer();
  warm.push(new Uint8Array(84));
  try { warm.finish(); } catch { /* 忽略 */ }

  const analyzer = new StlAnalyzer();
  const before = heapUsed();
  let total = 0;
  for (const chunk of bigBinaryChunks()) {
    total += chunk.length;
    analyzer.push(chunk);
  }
  const meta = analyzer.finish();
  const after = heapUsed();

  assert.ok(total > 47 * 1024 * 1024, `input too small: ${total}`);
  assert.equal(meta.format, 'binary');
  assert.equal(meta.triangleCount, 1_000_000);
  const growthMiB = (after - before) / (1024 * 1024);
  assert.ok(
    growthMiB < 32,
    `heap grew ${growthMiB.toFixed(1)} MiB while streaming ${(total / 1024 / 1024).toFixed(0)} MiB`,
  );
});
