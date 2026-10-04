import { test } from "node:test";
import assert from "node:assert/strict";
import { createSession } from "../src/index.ts";
import type { SampleInput } from "../src/index.ts";
import {
  bruteForceRecommend,
  mulberry32,
  randomRepresentatives,
} from "./helpers.ts";

test("degenerate: 20000 samples sharing a few feature vectors, batch 200", () => {
  const rand = mulberry32(555);
  const representatives = randomRepresentatives(2_000, rand);
  // 只有 8 种不同特征，20000 条样本（不同 ID 可有完全相同的特征）。
  const prototypes = Array.from({ length: 8 }, () =>
    Array.from({ length: 16 }, () => Math.floor(rand() * 256)),
  );
  const samples: SampleInput[] = Array.from({ length: 20_000 }, (_, id) => ({
    id,
    features: prototypes[id % prototypes.length]!,
  }));

  const start = performance.now();
  const session = createSession({ samples, representatives });
  const batch = session.recommend(200);
  const elapsedMs = performance.now() - start;
  console.log(`  [degenerate] batch of 200: ${elapsedMs.toFixed(0)} ms`);

  assert.equal(batch.length, 200);
  assert.equal(new Set(batch).size, 200);
  assert.ok(elapsedMs < 60_000);

  // 收益相同的同特征样本必须按 ID 升序被选中：用小规模副本对照暴力实现。
  const smallSamples = samples.slice(0, 24);
  const smallReps = representatives.slice(0, 6);
  const small = createSession({ samples: smallSamples, representatives: smallReps });
  assert.deepEqual(
    small.recommend(12),
    bruteForceRecommend(smallSamples, smallReps, new Set(), 12),
  );
});

test("degenerate: all remaining gains are zero, batch filled by id order", () => {
  const rand = mulberry32(777);
  // 已标注样本精确覆盖全部代表点（特征相同），所有候选收益恒为 0。
  const representatives = randomRepresentatives(2_000, rand);
  const labeled: SampleInput[] = representatives.map((rep, i) => ({
    id: 1_000_000 + i,
    features: [...rep.features],
  }));
  const candidates: SampleInput[] = Array.from({ length: 5_000 }, (_, id) => ({
    id,
    features: Array.from({ length: 16 }, () => Math.floor(rand() * 256)),
  }));
  const samples = [...candidates, ...labeled];

  const start = performance.now();
  const session = createSession({
    samples,
    representatives,
    labeledIds: labeled.map((s) => s.id),
  });
  const batch = session.recommend(200);
  const elapsedMs = performance.now() - start;
  console.log(`  [zero-gain] batch of 200: ${elapsedMs.toFixed(0)} ms`);

  assert.deepEqual(batch, Array.from({ length: 200 }, (_, i) => i));
  assert.ok(elapsedMs < 60_000);
});
