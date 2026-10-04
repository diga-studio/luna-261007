import assert from "node:assert/strict";
import test from "node:test";
import { FunnelStats, type Day, type FlowId, type LeadId } from "../src/index.js";
import { ReferenceModel, rng } from "./reference.js";

type Op =
  | { kind: "add"; id: LeadId; flowId: FlowId; day: Day }
  | { kind: "convert"; id: LeadId }
  | { kind: "merge"; a: LeadId; b: LeadId };

function apply(f: FunnelStats, op: Op): void {
  if (op.kind === "add") f.add(op.id, op.flowId, op.day);
  else if (op.kind === "convert") f.convert(op.id);
  else f.merge(op.a, op.b);
}

function assertMatches(f: FunnelStats, ref: ReferenceModel, rand: () => number): void {
  const expected = ref.recompute();
  for (const flowId of ref.flowIds()) {
    const byDay = expected.get(flowId)!;
    const full = f.report(flowId, -1_000_000, 1_000_000);
    const wantDays = [...byDay.entries()]
      .map(([day, c]) => ({ day, ...c }))
      .filter((e) => e.captured !== 0 || e.converted !== 0)
      .sort((x, y) => x.day - y.day);
    assert.deepEqual(full.days, wantDays, `flow ${flowId} full range`);

    // 随机子区间核对。
    for (let i = 0; i < 3; i++) {
      const a = Math.floor(rand() * 400) - 50;
      const b = a + Math.floor(rand() * 120);
      const sub = f.report(flowId, a, b);
      const want = wantDays.filter((e) => e.day >= a && e.day <= b);
      assert.deepEqual(sub.days, want, `flow ${flowId} range [${a},${b}]`);
      assert.equal(
        sub.totalCaptured,
        want.reduce((s, e) => s + e.captured, 0),
      );
      assert.equal(
        sub.totalConverted,
        want.reduce((s, e) => s + e.converted, 0),
      );
    }
  }
}

test("随机操作序列与全量重算参考模型一致", () => {
  for (const seed of [1, 7, 42, 2026]) {
    const rand = rng(seed);
    const f = new FunnelStats();
    const ref = new ReferenceModel();
    const ids: LeadId[] = [];
    let nextId = 0;

    for (let step = 0; step < 1500; step++) {
      const roll = rand();
      if (roll < 0.45 || ids.length < 2) {
        const id = nextId++;
        const flowId = `F${Math.floor(rand() * 12)}`;
        const day = Math.floor(rand() * 365);
        const op: Op = { kind: "add", id, flowId, day };
        apply(f, op);
        ref.add(id, flowId, day);
        ids.push(id);
      } else if (roll < 0.65) {
        const id = ids[Math.floor(rand() * ids.length)]!;
        apply(f, { kind: "convert", id });
        ref.convert(id);
      } else {
        const a = ids[Math.floor(rand() * ids.length)]!;
        const b = ids[Math.floor(rand() * ids.length)]!;
        apply(f, { kind: "merge", a, b });
        ref.merge(a, b);
      }
      if (step % 100 === 99) assertMatches(f, ref, rand);
    }
    assertMatches(f, ref, rand);
  }
});

test("同一事实集：不同归并顺序与参数方向结果一致", () => {
  for (const seed of [11, 99, 12345]) {
    const rand = rng(seed);
    const adds: Extract<Op, { kind: "add" }>[] = [];
    const converts: Extract<Op, { kind: "convert" }>[] = [];
    const merges: Extract<Op, { kind: "merge" }>[] = [];

    const n = 400;
    for (let id = 0; id < n; id++) {
      adds.push({
        kind: "add",
        id,
        flowId: `F${Math.floor(rand() * 8)}`,
        day: Math.floor(rand() * 200),
      });
    }
    for (let i = 0; i < 80; i++) {
      converts.push({ kind: "convert", id: Math.floor(rand() * n) });
    }
    for (let i = 0; i < 250; i++) {
      merges.push({
        kind: "merge",
        a: Math.floor(rand() * n),
        b: Math.floor(rand() * n),
      });
    }

    // 实例 1：add -> 交错 convert/merge，正向。
    const f1 = new FunnelStats();
    const r1 = new ReferenceModel();
    for (const op of adds) {
      apply(f1, op);
      r1.add(op.id, op.flowId, op.day);
    }
    for (let i = 0; i < merges.length; i++) {
      const m = merges[i]!;
      apply(f1, m);
      r1.merge(m.a, m.b);
      if (i % 3 === 0 && converts.length > 0) {
        const c = converts[i % converts.length]!;
        apply(f1, c);
        r1.convert(c.id);
      }
    }
    for (const c of converts) {
      apply(f1, c);
      r1.convert(c.id);
    }

    // 实例 2：merge 逆序且全部交换参数方向，convert 集中在最前。
    const f2 = new FunnelStats();
    for (const op of adds) apply(f2, op);
    for (const c of converts) apply(f2, c);
    for (let i = merges.length - 1; i >= 0; i--) {
      const m = merges[i]!;
      apply(f2, { kind: "merge", a: m.b, b: m.a });
    }

    assertMatches(f2, r1, rand);
    // 两个实例彼此也应一致。
    for (const flowId of r1.flowIds()) {
      assert.deepEqual(
        f1.report(flowId, -1_000_000, 1_000_000).days,
        f2.report(flowId, -1_000_000, 1_000_000).days,
        `flow ${flowId} instance1 vs instance2`,
      );
    }
  }
});
