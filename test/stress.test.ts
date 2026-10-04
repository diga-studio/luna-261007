import assert from "node:assert/strict";
import test from "node:test";
import { FunnelStats } from "../src/index.js";
import { ReferenceModel } from "./reference.js";

test("压力：6万条线索，大组跨500渠道持续吸收单条线索", { timeout: 60_000 }, () => {
  const TOTAL = 60_000;
  const MERGED = 50_000; // id [0, MERGED) 全部并入大组
  const FLOWS = 500;
  const flowOf = (i: number) => `F${i % FLOWS}`;
  const dayOf = (i: number) => (i * 7) % 997;

  const f = new FunnelStats();
  const ref = new ReferenceModel();

  const t0 = Date.now();
  for (let i = 0; i < TOTAL; i++) {
    f.add(i, flowOf(i), dayOf(i));
    ref.add(i, flowOf(i), dayOf(i));
  }
  // 大组持续吸收单条线索，交替交换 merge 参数方向。
  for (let i = 1; i < MERGED; i++) {
    if (i % 2 === 0) {
      f.merge(0, i);
    } else {
      f.merge(i, 0);
    }
    ref.merge(0, i);
    // 吸收过程中抽查若干渠道报告，保证每步操作后立即正确。
    if (i % 10_000 === 0) {
      const spot = f.report(flowOf(i), 0, 1000);
      // 大组贡献 1 条；id > i 的同渠道线索尚未并入，各自贡献 1 条。
      let standalone = 0;
      for (let j = i + 1; j < TOTAL; j++) if (flowOf(j) === flowOf(i)) standalone++;
      assert.equal(spot.totalCaptured, 1 + standalone);
    }
  }
  const tMerged = Date.now();

  // 通过早期 id 转化整个大组。
  f.convert(0);
  ref.convert(0);
  // 旧 id 重复转化、反向同组归并均无额外影响。
  f.convert(MERGED - 1);
  f.merge(MERGED - 1, 0);
  ref.convert(MERGED - 1); // 幂等：参考模型中本就已转化（同组）

  // 全量核对所有渠道（500 个）完整区间。
  const expected = ref.recompute();
  for (let c = 0; c < FLOWS; c++) {
    const flowId = `F${c}`;
    const got = f.report(flowId, 0, 1000);
    const byDay = expected.get(flowId)!;
    const want = [...byDay.entries()]
      .map(([day, counts]) => ({ day, ...counts }))
      .sort((a, b) => a.day - b.day);
    assert.deepEqual(got.days, want, `flow ${flowId}`);
  }

  // 抽查大组渠道：恰有一条 captured + 一条 converted，落在该渠道最早日。
  for (const c of [0, 1, 250, 499]) {
    const flowId = `F${c}`;
    let minDay = Infinity;
    for (let i = c; i < MERGED; i += FLOWS) minDay = Math.min(minDay, dayOf(i));
    const r = f.report(flowId, 0, 1000);
    const mergedCount = Math.ceil((MERGED - c) / FLOWS);
    const standalone = [];
    for (let i = Math.max(MERGED, c); i < TOTAL; i += FLOWS) {
      if (i >= MERGED) standalone.push(i);
    }
    assert.equal(r.totalCaptured, mergedCount > 0 ? 1 + standalone.length : standalone.length);
    assert.equal(r.totalConverted, 1);
    const mergedEntry = r.days.find((e) => e.day === minDay);
    assert.ok(mergedEntry, `flow ${flowId} should have entry at day ${minDay}`);
    assert.equal(mergedEntry.captured >= 1, true);
    assert.equal(mergedEntry.converted, 1);
  }

  const tDone = Date.now();
  // 防止退化为平方级：6 万条线索的全流程应在数秒内完成。
  assert.ok(
    tDone - t0 < 20_000,
    `too slow: add ${tMerged - t0}ms(+merge), total ${tDone - t0}ms`,
  );
});
