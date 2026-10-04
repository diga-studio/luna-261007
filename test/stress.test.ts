import { test } from "node:test";
import { ok } from "node:assert/strict";
import { FunnelStats } from "../src/index";
import { Op, mulberry32, applyOps, assertReportsMatch } from "./helpers";

test("压力：6 万条线索，大组持续吸收单条线索并交替参数方向", () => {
  const rand = mulberry32(424242);
  const channelCount = 3000;
  const dayRange = 10000;
  const bigGroupSize = 45000;
  const otherCount = 15000;
  const flowIds: string[] = [];
  for (let i = 0; i < channelCount; i++) flowIds.push(`F${i}`);

  const stats = new FunnelStats();
  const ops: Op[] = [];
  const run = (op: Op) => {
    ops.push(op);
    applyOps(stats, [op]);
  };

  const started = Date.now();

  // 大组的第一条线索（早期 id，最后通过它转化整组）。
  const anchor = "L0";
  run({ type: "add", id: anchor, flowId: flowIds[0] as string, day: Math.floor(rand() * dayRange) });

  // 大组逐条吸收单条线索，交替交换 merge 参数方向；不触发转化状态变化。
  for (let i = 1; i < bigGroupSize; i++) {
    const id = `L${i}`;
    run({ type: "add", id, flowId: flowIds[i % channelCount] as string, day: Math.floor(rand() * dayRange) });
    if (i % 2 === 0) {
      run({ type: "merge", a: id, b: anchor });
    } else {
      run({ type: "merge", a: anchor, b: id });
    }
  }

  // 其余线索：独立或小组，部分转化（不影响大组）。
  const otherIds: string[] = [];
  for (let i = 0; i < otherCount; i++) {
    const id = `S${i}`;
    otherIds.push(id);
    run({ type: "add", id, flowId: flowIds[Math.floor(rand() * channelCount)] as string, day: Math.floor(rand() * dayRange) });
    if (i % 3 === 0 && i > 0) {
      run({ type: "merge", a: id, b: otherIds[i - 1] as string });
    }
    if (rand() < 0.2) {
      run({ type: "convert", id });
    }
  }

  const elapsedBeforeConvert = Date.now() - started;

  // 转化前核对一批渠道的报告。
  const sampleFlows: string[] = [];
  for (let i = 0; i < channelCount; i += Math.floor(channelCount / 40)) {
    sampleFlows.push(flowIds[i] as string);
  }
  assertReportsMatch(stats, ops, sampleFlows, 0, dayRange - 1, "before-convert");

  // 通过早期 id 转化整个大组。
  run({ type: "convert", id: anchor });

  // 转化后核对同一批渠道：大组覆盖的渠道应各有一次 captured 与 converted。
  assertReportsMatch(stats, ops, sampleFlows, 0, dayRange - 1, "after-convert");

  const elapsed = Date.now() - started;
  // 防止退化为平方级：6 万条线索的全部操作应在数秒内完成。
  ok(elapsedBeforeConvert < 10000, `merge phase too slow: ${elapsedBeforeConvert}ms`);
  ok(elapsed < 15000, `total too slow: ${elapsed}ms`);
  console.log(`stress: merge phase ${elapsedBeforeConvert}ms, total ${elapsed}ms`);
});
