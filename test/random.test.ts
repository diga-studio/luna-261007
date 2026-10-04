import { test } from "node:test";
import { deepEqual } from "node:assert/strict";
import { FunnelStats } from "../src/index";
import { Op, mulberry32, pick, applyOps, assertReportsMatch } from "./helpers";

test("随机操作序列：每步后与全量重算参考模型核对", () => {
  const rand = mulberry32(20261005);
  const flowIds = ["X", "Y", "Z", "W", "V"];
  const maxDay = 25;
  const stats = new FunnelStats();
  const ops: Op[] = [];
  const ids: string[] = [];

  for (let step = 0; step < 400; step++) {
    const roll = rand();
    let op: Op;
    if (ids.length === 0 || roll < 0.45) {
      const id = `L${ids.length}`;
      op = { type: "add", id, flowId: pick(rand, flowIds), day: Math.floor(rand() * maxDay) };
      ids.push(id);
    } else if (roll < 0.7) {
      op = { type: "convert", id: pick(rand, ids) };
    } else {
      op = { type: "merge", a: pick(rand, ids), b: pick(rand, ids) };
    }
    ops.push(op);
    applyOps(stats, [op]);
    assertReportsMatch(stats, ops, flowIds, 0, maxDay - 1, `step=${step}`);
  }
});

test("同一事实集：不同归并顺序与参数方向结果一致", () => {
  const rand = mulberry32(777);
  const flowIds = ["X", "Y", "Z"];
  const maxDay = 15;
  const idCount = 60;

  const adds: Op[] = [];
  const ids: string[] = [];
  for (let i = 0; i < idCount; i++) {
    const id = `L${i}`;
    ids.push(id);
    adds.push({ type: "add", id, flowId: pick(rand, flowIds), day: Math.floor(rand() * maxDay) });
  }
  const converts: Op[] = [];
  for (const id of ids) {
    if (rand() < 0.3) converts.push({ type: "convert", id });
  }
  const merges: Op[] = [];
  for (let i = 0; i < 45; i++) {
    merges.push({ type: "merge", a: pick(rand, ids), b: pick(rand, ids) });
  }

  // 顺序一：adds -> converts -> merges（原方向）
  const ops1 = [...adds, ...converts, ...merges];
  // 顺序二：merges 打乱且参数反向，converts 穿插在归并之间
  const rand2 = mulberry32(888);
  const shuffledMerges = merges
    .map((m) => ({ type: "merge", a: (m as { b: string }).b, b: (m as { a: string }).a } as Op))
    .sort(() => rand2() - 0.5);
  const ops2: Op[] = [...adds];
  const convQueue = [...converts];
  for (const m of shuffledMerges) {
    ops2.push(m);
    if (convQueue.length > 0 && rand2() < 0.5) ops2.push(convQueue.shift() as Op);
  }
  ops2.push(...convQueue);

  const stats1 = new FunnelStats();
  applyOps(stats1, ops1);
  const stats2 = new FunnelStats();
  applyOps(stats2, ops2);

  for (const f of flowIds) {
    deepEqual(stats2.report(f, 0, maxDay - 1), stats1.report(f, 0, maxDay - 1), `order flowId=${f}`);
  }
  // 两种顺序都必须等于参考模型
  assertReportsMatch(stats1, ops1, flowIds, 0, maxDay - 1, "order1");
  assertReportsMatch(stats2, ops2, flowIds, 0, maxDay - 1, "order2");
});
