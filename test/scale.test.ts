import { test } from "node:test";
import assert from "node:assert/strict";
import { createSession } from "../src/index.ts";
import {
  mulberry32,
  randomRepresentatives,
  randomSamples,
} from "./helpers.ts";

const MIB = 1024 * 1024;

function memoryUsageBytes(): number {
  const usage = process.memoryUsage();
  return usage.heapUsed + usage.external + usage.arrayBuffers;
}

function runGc(): void {
  (globalThis as { gc?: () => void }).gc?.();
}

test("full scale: 20000 samples, 2000 representatives, batch of 200", () => {
  const rand = mulberry32(2024);
  const sampleCount = 20_000;
  const repCount = 2_000;
  const batchSize = 200;
  const labeledCount = 500;

  const samples = randomSamples(sampleCount, rand);
  const representatives = randomRepresentatives(repCount, rand);
  const labeledIds: number[] = [];
  while (labeledIds.length < labeledCount) {
    const id = samples[Math.floor(rand() * sampleCount)]!.id;
    if (!labeledIds.includes(id)) labeledIds.push(id);
  }

  runGc();
  const memBefore = memoryUsageBytes();
  const start = performance.now();

  // 从首次接收输入到返回首批结果。
  const session = createSession({ samples, representatives, labeledIds });
  const batch = session.recommend(batchSize);

  const elapsedMs = performance.now() - start;
  runGc();
  const memAfter = memoryUsageBytes();
  const extraMemBytes = Math.max(0, memAfter - memBefore);

  console.log(
    `  [scale] first batch: ${elapsedMs.toFixed(0)} ms, ` +
      `extra memory: ${(extraMemBytes / MIB).toFixed(1)} MiB`,
  );

  // 返回数量、唯一性、已标注样本排除。
  assert.equal(batch.length, batchSize);
  assert.equal(new Set(batch).size, batchSize);
  const labeledSet = new Set(labeledIds);
  for (const id of batch) {
    assert.ok(!labeledSet.has(id), `labeled sample ${id} must be excluded`);
  }

  // 非功能要求：首批总耗时不超过 60 秒，峰值额外内存不超过 64 MiB。
  assert.ok(elapsedMs < 60_000, `first batch took ${elapsedMs.toFixed(0)} ms`);
  assert.ok(
    extraMemBytes < 64 * MIB,
    `extra memory ${(extraMemBytes / MIB).toFixed(1)} MiB exceeds 64 MiB`,
  );

  // 标注状态不变时重复请求结果一致；较短结果是较长结果的前缀。
  const again = session.recommend(batchSize);
  assert.deepEqual(again, batch);
  const short = session.recommend(50);
  assert.deepEqual(batch.slice(0, 50), short);

  // 标记其中一部分后，与仅包含实际已标注集合的新会话一致。
  const actuallyLabeled = batch.slice(0, 100);
  session.markLabeled(actuallyLabeled);
  const fresh = createSession({
    samples,
    representatives,
    labeledIds: [...labeledIds, ...actuallyLabeled],
  });
  assert.deepEqual(session.recommend(20), fresh.recommend(20));
});
