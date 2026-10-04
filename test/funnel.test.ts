import { test } from "node:test";
import { deepEqual } from "node:assert/strict";
import { FunnelStats } from "../src/index";

function compact(entries: { day: number; captured: number; converted: number }[]) {
  return entries.filter((e) => e.captured !== 0 || e.converted !== 0);
}

test("A(X,5,converted) + B(X,2) + C(Y,7)，先归并 B、C 再归并 A、B", () => {
  const stats = new FunnelStats();
  stats.add("A", "X", 5);
  stats.add("B", "X", 2);
  stats.add("C", "Y", 7);
  stats.convert("A");

  stats.merge("B", "C");
  stats.merge("A", "B");

  deepEqual(compact(stats.report("X", 1, 10)), [
    { day: 2, captured: 1, converted: 1 },
  ]);
  deepEqual(compact(stats.report("Y", 1, 10)), [
    { day: 7, captured: 1, converted: 1 },
  ]);
  // 第 5 日的贡献已消失
  deepEqual(stats.report("X", 5, 5), [{ day: 5, captured: 0, converted: 0 }]);

  // 通过旧 id 重复转化、同组反向归并均不改变结果
  stats.convert("B");
  stats.convert("C");
  stats.convert("A");
  stats.merge("B", "A");
  stats.merge("C", "A");
  stats.merge("C", "B");

  deepEqual(compact(stats.report("X", 1, 10)), [
    { day: 2, captured: 1, converted: 1 },
  ]);
  deepEqual(compact(stats.report("Y", 1, 10)), [
    { day: 7, captured: 1, converted: 1 },
  ]);
});

test("基本增删查：未转化与转化的独立线索", () => {
  const stats = new FunnelStats();
  stats.add("l1", "X", 3);
  stats.add("l2", "X", 3);
  stats.add("l3", "X", 4);
  stats.convert("l2");

  deepEqual(stats.report("X", 3, 4), [
    { day: 3, captured: 2, converted: 1 },
    { day: 4, captured: 1, converted: 0 },
  ]);
  // 无贡献的日期与渠道为零
  deepEqual(stats.report("X", 1, 2), [
    { day: 1, captured: 0, converted: 0 },
    { day: 2, captured: 0, converted: 0 },
  ]);
  deepEqual(stats.report("Y", 1, 5).every((e) => e.captured === 0 && e.converted === 0), true);

  // 重复 convert 幂等
  stats.convert("l2");
  deepEqual(stats.report("X", 3, 3), [{ day: 3, captured: 2, converted: 1 }]);
});

test("归并后转化作用于整组，且落在最早日期", () => {
  const stats = new FunnelStats();
  stats.add("a", "X", 9);
  stats.add("b", "X", 4);
  stats.add("c", "Y", 6);
  stats.merge("a", "b");
  stats.merge("b", "c");
  stats.convert("c");

  deepEqual(stats.report("X", 1, 10).filter((e) => e.captured || e.converted), [
    { day: 4, captured: 1, converted: 1 },
  ]);
  deepEqual(stats.report("Y", 1, 10).filter((e) => e.captured || e.converted), [
    { day: 6, captured: 1, converted: 1 },
  ]);
});
