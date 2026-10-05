import { test } from "node:test";
import assert from "node:assert/strict";
import { planPicking } from "../src/planner";
import type { CandidateOrder, InventorySnapshot } from "../src/types";

const seqsOf = (orders: readonly CandidateOrder[]): number[] =>
  orders.map((o) => o.submissionSeq);

test("大礼包不能占尽库存：同等数量下选字典序最小的名单", () => {
  const inventory: InventorySnapshot = { cup: 2, badge: 2 };
  const orders: CandidateOrder[] = [
    { submissionSeq: 1, lines: [
      { variantId: "cup", quantity: 2 },
      { variantId: "badge", quantity: 2 },
    ] },
    { submissionSeq: 2, lines: [
      { variantId: "cup", quantity: 1 },
      { variantId: "badge", quantity: 1 },
    ] },
    { submissionSeq: 3, lines: [
      { variantId: "cup", quantity: 1 },
      { variantId: "badge", quantity: 1 },
    ] },
    { submissionSeq: 4, lines: [
      { variantId: "cup", quantity: 1 },
      { variantId: "badge", quantity: 1 },
    ] },
  ];

  const plan = planPicking(orders, inventory);
  // 必须选 2 和 3：不能选大单 1，也不能在同为 2 单时改选 2 和 4
  assert.deepEqual(seqsOf(plan.selectedOrders), [2, 3]);
});

test("不同颜色变体库存不可互相替代", () => {
  const inventory: InventorySnapshot = { "mug:red": 0, "mug:blue": 1 };
  const orders: CandidateOrder[] = [
    { submissionSeq: 1, lines: [{ variantId: "mug:red", quantity: 1 }] },
    { submissionSeq: 2, lines: [{ variantId: "mug:blue", quantity: 1 }] },
  ];

  const plan = planPicking(orders, inventory);
  assert.deepEqual(seqsOf(plan.selectedOrders), [2]);
});

test("平局规则是名单字典序，而不是序号总和", () => {
  // 可行两单方案只有 {1,9} 与 {2,3}
  // 字典序最小为 [1,9]；若误用序号总和最小则会得到 [2,3]
  const inventory: InventorySnapshot = { A: 1, B: 1, C: 1, D: 1 };
  const orders: CandidateOrder[] = [
    { submissionSeq: 1, lines: [
      { variantId: "A", quantity: 1 },
      { variantId: "D", quantity: 1 },
    ] },
    { submissionSeq: 2, lines: [
      { variantId: "A", quantity: 1 },
      { variantId: "B", quantity: 1 },
    ] },
    { submissionSeq: 3, lines: [
      { variantId: "C", quantity: 1 },
      { variantId: "D", quantity: 1 },
    ] },
    { submissionSeq: 9, lines: [
      { variantId: "B", quantity: 1 },
      { variantId: "C", quantity: 1 },
    ] },
  ];

  const plan = planPicking(orders, inventory);
  assert.deepEqual(seqsOf(plan.selectedOrders), [1, 9]);
});

test("合计需求不得超过任一变体库存，且库存快照不被修改", () => {
  const inventory: InventorySnapshot = { "tee:M": 2 };
  const snapshotBefore = { ...inventory };
  const orders: CandidateOrder[] = [1, 2, 3].map((seq) => ({
    submissionSeq: seq,
    lines: [{ variantId: "tee:M", quantity: 1 }],
  }));

  const plan = planPicking(orders, inventory);
  assert.deepEqual(seqsOf(plan.selectedOrders), [1, 2]);
  assert.deepEqual(inventory, snapshotBefore);
});

test("缺货变体导致整单不入选，其余订单不受影响", () => {
  const inventory: InventorySnapshot = { "cap:black": 1 };
  const orders: CandidateOrder[] = [
    { submissionSeq: 1, lines: [
      { variantId: "cap:black", quantity: 1 },
      { variantId: "cap:white", quantity: 1 },
    ] },
    { submissionSeq: 2, lines: [{ variantId: "cap:black", quantity: 1 }] },
  ];

  const plan = planPicking(orders, inventory);
  assert.deepEqual(seqsOf(plan.selectedOrders), [2]);
});

test("边界：无订单或无库存", () => {
  assert.deepEqual(planPicking([], { a: 1 }).selectedOrders, []);
  const plan = planPicking(
    [{ submissionSeq: 1, lines: [{ variantId: "a", quantity: 1 }] }],
    {},
  );
  assert.deepEqual(plan.selectedOrders, []);
});

test("输入校验：重复提交序号与非正整数件数抛错", () => {
  assert.throws(() =>
    planPicking(
      [
        { submissionSeq: 1, lines: [{ variantId: "a", quantity: 1 }] },
        { submissionSeq: 1, lines: [{ variantId: "a", quantity: 1 }] },
      ],
      { a: 2 },
    ),
  );
  assert.throws(() =>
    planPicking(
      [{ submissionSeq: 1, lines: [{ variantId: "a", quantity: 0 }] }],
      { a: 1 },
    ),
  );
});
