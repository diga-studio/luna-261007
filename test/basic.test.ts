import test from "node:test";
import assert from "node:assert/strict";
import { makeRig, assertSnapshotConsistent, sleep } from "./helpers.ts";

test("接受兑换：同时扣减积分、库存与季度名额", async () => {
  const rig = makeRig();
  const result = rig.service.redeem("e1", "r1", "red-1");
  assert.equal(result.accepted, true);
  assert.equal(result.redemption!.status, "PENDING");
  assert.equal(result.redemption!.quarter, "2026-Q1");

  const snap = rig.service.snapshot();
  assert.equal(snap.employees[0].availablePoints, 900);
  assert.equal(snap.rewards[0].availableStock, 9);
  assert.deepEqual(snap.quarterlyUsage, [
    { employeeId: "e1", rewardId: "r1", quarter: "2026-Q1", used: 1 },
  ]);
  assertSnapshotConsistent(snap, rig.employees, rig.rewards);
  rig.service.close();
});

test("重复发起同一ID：返回同一兑换，不重复扣减，不另起履约尝试", async () => {
  const rig = makeRig();
  const first = rig.service.redeem("e1", "r1", "red-dup");
  const second = rig.service.redeem("e1", "r1", "red-dup");
  assert.equal(second.accepted, true);
  assert.equal(second.deduplicated, true);
  assert.equal(second.redemption!.id, first.redemption!.id);

  await sleep(200); // 超过重试定时，确保不会为重复ID另起尝试
  assert.equal(rig.gate.attemptsOf("red-dup").length, 3); // 只有第一笔的三次尝试

  const snap = rig.service.snapshot();
  assert.equal(snap.employees[0].availablePoints, 900);
  assert.equal(snap.rewards[0].availableStock, 9);
  assert.equal(snap.redemptions.length, 1);
  assertSnapshotConsistent(snap, rig.employees, rig.rewards);
  rig.service.close();
});

test("积分不足：整笔拒绝，资源不变", async () => {
  const rig = makeRig({ employees: [{ id: "e1", points: 50 }] });
  const result = rig.service.redeem("e1", "r1", "red-poor");
  assert.equal(result.accepted, false);
  assert.equal(result.reason, "INSUFFICIENT_POINTS");
  const snap = rig.service.snapshot();
  assert.equal(snap.employees[0].availablePoints, 50);
  assert.equal(snap.rewards[0].availableStock, 10);
  assert.equal(snap.redemptions.length, 0);
  rig.service.close();
});

test("库存不足：整笔拒绝，资源不变", async () => {
  const rig = makeRig({ rewards: [{ id: "r1", price: 100, stock: 0 }] });
  const result = rig.service.redeem("e1", "r1", "red-nostock");
  assert.equal(result.accepted, false);
  assert.equal(result.reason, "OUT_OF_STOCK");
  const snap = rig.service.snapshot();
  assert.equal(snap.employees[0].availablePoints, 1000);
  assert.equal(snap.rewards[0].availableStock, 0);
  rig.service.close();
});

test("季度名额：同员工同奖励每季度最多两笔，第三笔拒绝且资源不变", async () => {
  const rig = makeRig();
  assert.equal(rig.service.redeem("e1", "r1", "red-q1").accepted, true);
  assert.equal(rig.service.redeem("e1", "r1", "red-q2").accepted, true);
  const third = rig.service.redeem("e1", "r1", "red-q3");
  assert.equal(third.accepted, false);
  assert.equal(third.reason, "QUOTA_EXCEEDED");

  const snap = rig.service.snapshot();
  assert.equal(snap.employees[0].availablePoints, 800);
  assert.equal(snap.rewards[0].availableStock, 8);
  assert.deepEqual(snap.quarterlyUsage, [
    { employeeId: "e1", rewardId: "r1", quarter: "2026-Q1", used: 2 },
  ]);
  assertSnapshotConsistent(snap, rig.employees, rig.rewards);
  rig.service.close();
});

test("已完成兑换仍占季度名额；拒绝后名额释放", async () => {
  const rig = makeRig();
  rig.service.redeem("e1", "r1", "red-c1");
  rig.gate.succeed("red-c1", 0);
  await sleep(10);
  assert.equal(rig.service.snapshot().redemptions[0].status, "COMPLETED");

  rig.service.redeem("e1", "r1", "red-c2");
  // 已完成仍占名额：第三笔被拒
  assert.equal(rig.service.redeem("e1", "r1", "red-c3").reason, "QUOTA_EXCEEDED");

  // red-c2 三次均失败 → REJECTED，名额与资源释放
  rig.gate.fail("red-c2", 0);
  await sleep(60);
  rig.gate.fail("red-c2", 1);
  await sleep(60);
  rig.gate.fail("red-c2", 2);
  await sleep(10);
  const snap = rig.service.snapshot();
  const c2 = snap.redemptions.find((r) => r.id === "red-c2")!;
  assert.equal(c2.status, "REJECTED");
  assert.equal(snap.employees[0].availablePoints, 900); // 只扣 completed 那笔
  assert.equal(snap.rewards[0].availableStock, 9);
  assert.deepEqual(snap.quarterlyUsage, [
    { employeeId: "e1", rewardId: "r1", quarter: "2026-Q1", used: 1 },
  ]);
  // 名额释放后可以再兑换
  assert.equal(rig.service.redeem("e1", "r1", "red-c4").accepted, true);
  assertSnapshotConsistent(rig.service.snapshot(), rig.employees, rig.rewards);
  rig.service.close();
});
