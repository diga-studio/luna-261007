import assert from "node:assert/strict";
import test from "node:test";
import { FunnelStats } from "../src/index.js";

test("规格场景：A(X,5,已转化) B(X,2) C(Y,7)，先并 B-C 再并 A-B", () => {
  const f = new FunnelStats();
  f.add("A", "X", 5);
  f.convert("A");
  f.add("B", "X", 2);
  f.add("C", "Y", 7);

  f.merge("B", "C");
  f.merge("A", "B");

  // X 仅在第 2 日各贡献一条 captured/converted，第 5 日贡献消失。
  const x = f.report("X", 0, 100);
  assert.deepEqual(x.days, [{ day: 2, captured: 1, converted: 1 }]);
  assert.equal(x.totalCaptured, 1);
  assert.equal(x.totalConverted, 1);
  assert.deepEqual(f.report("X", 5, 5).days, []);

  // Y 在第 7 日各贡献一条。
  const y = f.report("Y", 0, 100);
  assert.deepEqual(y.days, [{ day: 7, captured: 1, converted: 1 }]);

  // 通过旧 id 重复转化、同组/反向归并均不改变结果。
  f.convert("A");
  f.convert("B");
  f.convert("C");
  f.merge("C", "A");
  f.merge("B", "A");
  assert.deepEqual(f.report("X", 0, 100).days, [{ day: 2, captured: 1, converted: 1 }]);
  assert.deepEqual(f.report("Y", 0, 100).days, [{ day: 7, captured: 1, converted: 1 }]);
});

test("区间边界与零贡献日期", () => {
  const f = new FunnelStats();
  f.add(1, "X", 10);
  f.add(2, "X", 20);
  f.convert(2);
  const r = f.report("X", 10, 20);
  assert.deepEqual(r.days, [
    { day: 10, captured: 1, converted: 0 },
    { day: 20, captured: 1, converted: 1 },
  ]);
  assert.equal(f.report("X", 11, 19).totalCaptured, 0);
  assert.equal(f.report("X", 0, 9).totalConverted, 0);
  // 未知渠道返回全零。
  const empty = f.report("ZZZ", 0, 1000);
  assert.deepEqual(empty.days, []);
  assert.equal(empty.totalCaptured, 0);
});

test("归并让较早日期的计数增加、另一渠道首次出现转化贡献", () => {
  const f = new FunnelStats();
  f.add("a", "X", 9);
  f.convert("a");
  f.add("b", "X", 3);
  f.add("c", "Y", 4);
  f.merge("b", "c"); // {X:3, Y:4} 未转化
  assert.equal(f.report("Y", 0, 100).totalConverted, 0);
  f.merge("a", "b"); // 已转化组并入：X 移到第3日，Y 首次出现转化
  assert.deepEqual(f.report("X", 0, 100).days, [{ day: 3, captured: 1, converted: 1 }]);
  assert.deepEqual(f.report("Y", 0, 100).days, [{ day: 4, captured: 1, converted: 1 }]);
});
