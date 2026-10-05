import test from "node:test";
import assert from "node:assert/strict";
import { makeRig, assertSnapshotConsistent, sleep } from "./helpers.ts";

test("HR处理中可查询与申请取消：取消立即返回CANCELLING并继续占用资源", async () => {
  const rig = makeRig();
  rig.service.redeem("e1", "r1", "red-x");

  // HR 处理期间查询正常返回
  const midSnap = rig.service.snapshot();
  assert.equal(midSnap.redemptions[0].status, "PENDING");

  const result = rig.service.cancel("red-x"); // 立即返回
  assert.equal(result.redemption.status, "CANCELLING");
  assert.equal(result.redemption.cancelRequested, true);

  // 取消处理中仍占用资源
  const snap = rig.service.snapshot();
  assert.equal(snap.employees[0].availablePoints, 900);
  assert.equal(snap.rewards[0].availableStock, 9);
  assert.deepEqual(snap.quarterlyUsage, [
    { employeeId: "e1", rewardId: "r1", quarter: "2026-Q1", used: 1 },
  ]);
  assertSnapshotConsistent(snap, rig.employees, rig.rewards);
  rig.service.close();
});

test("取消处理中已启动尝试全部失败：取消终结并归还资源，且只归还一次", async () => {
  const rig = makeRig({ retryDelaysMs: [40, 80] });
  rig.service.redeem("e1", "r1", "red-cf");
  await sleep(100); // 三次尝试均已启动
  rig.service.cancel("red-cf");

  rig.gate.fail("red-cf", 0);
  rig.gate.fail("red-cf", 1);
  await sleep(10);
  assert.equal(rig.service.snapshot().redemptions[0].status, "CANCELLING");

  rig.gate.fail("red-cf", 2);
  await sleep(10);
  const snap = rig.service.snapshot();
  assert.equal(snap.redemptions[0].status, "CANCELLED");
  assert.equal(snap.employees[0].availablePoints, 1000);
  assert.equal(snap.rewards[0].availableStock, 10);
  assert.deepEqual(snap.quarterlyUsage, []);

  // 重复取消幂等，不重复释放
  const again = rig.service.cancel("red-cf");
  assert.equal(again.redemption.status, "CANCELLED");
  const snap2 = rig.service.snapshot();
  assert.equal(snap2.employees[0].availablePoints, 1000);
  assert.equal(snap2.rewards[0].availableStock, 10);
  assertSnapshotConsistent(snap2, rig.employees, rig.rewards);
  rig.service.close();
});

test("取消处理中迟到成功：兑换完成且不退款", async () => {
  const rig = makeRig({ retryDelaysMs: [40, 80] });
  rig.service.redeem("e1", "r1", "red-cs");
  await sleep(50); // 第二次尝试已启动
  assert.equal(rig.gate.attemptsOf("red-cs").length, 2);

  rig.gate.fail("red-cs", 1); // 新尝试先失败
  rig.service.cancel("red-cs"); // 第一次仍未返回 → CANCELLING
  assert.equal(rig.service.snapshot().redemptions[0].status, "CANCELLING");

  rig.gate.succeed("red-cs", 0); // 旧尝试迟到成功
  await sleep(10);
  const snap = rig.service.snapshot();
  assert.equal(snap.redemptions[0].status, "COMPLETED");
  assert.equal(snap.employees[0].availablePoints, 900);
  assert.equal(snap.rewards[0].availableStock, 9);
  assertSnapshotConsistent(snap, rig.employees, rig.rewards);
  rig.service.close();
});

test("尚无未决尝试时取消：立即终结并归还资源，后续不再启动尝试", async () => {
  const rig = makeRig({ retryDelaysMs: [80, 160] });
  rig.service.redeem("e1", "r1", "red-ci");
  rig.gate.fail("red-ci", 0); // 第一次失败，第二次未到定时
  await sleep(10);

  const result = rig.service.cancel("red-ci");
  assert.equal(result.redemption.status, "CANCELLED");
  const snap = rig.service.snapshot();
  assert.equal(snap.employees[0].availablePoints, 1000);
  assert.equal(snap.rewards[0].availableStock, 10);

  await sleep(250); // 超过全部重试定时
  assert.equal(rig.gate.attemptsOf("red-ci").length, 1); // 未再启动
  assertSnapshotConsistent(rig.service.snapshot(), rig.employees, rig.rewards);
  rig.service.close();
});

test("取消申请停止尚未启动的尝试", async () => {
  const rig = makeRig({ retryDelaysMs: [60, 120] });
  rig.service.redeem("e1", "r1", "red-stop");
  rig.service.cancel("red-stop"); // 第一次尝试未决 → CANCELLING
  await sleep(200); // 超过重试定时
  assert.equal(rig.gate.attemptsOf("red-stop").length, 1); // 第2、3次未启动

  rig.gate.fail("red-stop", 0);
  await sleep(10);
  const snap = rig.service.snapshot();
  assert.equal(snap.redemptions[0].status, "CANCELLED");
  assert.equal(snap.employees[0].availablePoints, 1000);
  assertSnapshotConsistent(snap, rig.employees, rig.rewards);
  rig.service.close();
});
