import test from "node:test";
import assert from "node:assert/strict";
import { createImportSession } from "../src/index.js";
import type { CsvByteSource } from "../src/index.js";

/**
 * 满规模：1000 条记录 × 50 列 × 每单元格 4 KiB UTF-8 正文（约 200 MiB 总量），
 * 慢速消费。库造成的额外峰值堆内存不得超过 96 MiB（不计调用方保存的输出）。
 */
test("满规模文件慢速消费的额外峰值内存不超过 96 MiB", async (t) => {
  const RECORDS = 1000;
  const COLS = 50;
  const CELL_BYTES = 4096;
  // 4 KiB UTF-8 正文（多字节字符，同时锻炼流式解码）。
  const cell = "漢".repeat(Math.floor(CELL_BYTES / 3));
  const header = Array.from({ length: COLS }, (_, i) => `c${i}`).join(",");
  const record = Array.from({ length: COLS }, () => cell).join(",");

  const encoder = new TextEncoder();
  const CHUNK = 64 * 1024;
  async function* source(): CsvByteSource {
    let pending = encoder.encode(header + "\n");
    for (let r = 0; r < RECORDS; r++) {
      const recBytes = encoder.encode(record + (r % 7 === 0 ? "\r\n" : "\n"));
      const merged = new Uint8Array(pending.length + recBytes.length);
      merged.set(pending);
      merged.set(recBytes, pending.length);
      pending = merged;
      while (pending.length >= CHUNK) {
        yield pending.subarray(0, CHUNK);
        pending = pending.subarray(CHUNK);
      }
      // 慢速输入：每 50 条让出一次事件循环。
      if (r % 50 === 0) await new Promise((res) => setImmediate(res));
    }
    if (pending.length > 0) yield pending;
  }

  const gc = (globalThis as { gc?: () => void }).gc;
  gc?.();
  const baseline = process.memoryUsage().heapUsed;
  let peak = baseline;

  const session = await createImportSession(source());
  gc?.();
  peak = Math.max(peak, process.memoryUsage().heapUsed);
  assert.equal(session.header.length, COLS);
  assert.deepEqual(await session.types, Array.from({ length: COLS }, () => "text"));

  let count = 0;
  for await (const row of session.rows) {
    // 调用方不保存输出：校验后立即丢弃。
    assert.equal(row.cells.length, COLS);
    count++;
    if (count % 100 === 0) {
      // 回收瞬时垃圾后采样，度量的是库实际保留的存活内存。
      gc?.();
      peak = Math.max(peak, process.memoryUsage().heapUsed);
      // 慢速消费：让出事件循环。
      await new Promise((res) => setImmediate(res));
    }
  }
  gc?.();
  peak = Math.max(peak, process.memoryUsage().heapUsed);
  assert.equal(count, RECORDS);

  const extraMiB = (peak - baseline) / (1024 * 1024);
  t.diagnostic(`baseline=${(baseline / 1048576).toFixed(1)} MiB, peak extra=${extraMiB.toFixed(1)} MiB`);
  assert.ok(extraMiB <= 96, `extra peak memory ${extraMiB.toFixed(1)} MiB > 96 MiB`);
});
