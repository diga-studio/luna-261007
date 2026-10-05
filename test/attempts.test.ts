import test from "node:test";
import assert from "node:assert/strict";
import { makeRig, assertSnapshotConsistent, sleep } from "./helpers.ts";

test("重试调度：5秒/10秒定时可配置，未定局时启动第2、3次尝试，提前失败不提前下一次", async () => {
  const rig = makeRig({ retryDelaysMs: [80, 160] });
  rig.service.redeem("e1", "r1", "red-t");
  assert.equal(rig.gate.attemptsOf("red-t").length, 1); // 立即第一次

  rig.gate.fail("red-t", 0); // 第一次立即失败
  await sleep(40);
  assert.equal(rig.gate.attemptsOf("red-t").length, 1); // 不提前第二次

  await sleep(60); // t≈100 > 80
  assert.equal(rig.gate.attemptsOf("red-t").length, 2);
  rig.gate.fail("red-t", 1);
  await sleep(80); // t≈180 > 160
  assert.equal(rig.gate.attemptsOf("red-t").length, 3);

  rig.gate.fail("red-t", 2);
  await sleep(10);
  assert.equal(rig.service.snapshot().redemptions[0].status, "REJECTED");
  await sleep(200);
  assert.equal(rig.gate.attemptsOf("red-t").length, 3); // 最多三次
  rig.service.close();
});

test("三次均明确失败：拒绝兑换并一次性归还积分、库存与季度名额", async () => {
  const rig = makeRig({ retryDelaysMs: [30, 60] });
  rig.service.redeem("e1", "r1", "red-f");
  await sleep(80);
  assert.equal(rig.gate.attemptsOf("red-f").length, 3);
  rig.gate.fail("red-f", 0);
  rig.gate.fail("red-f", 1);
  rig.gate.fail("red-f", 2);
  await sleep(10);

  const snap = rig.service.snapshot();
  assert.equal(snap.redemptions[0].status, "REJECTED");
  assert.equal(snap.employees[0].availablePoints, 1000);
  assert.equal(snap.rewards[0].availableStock, 10);
  assert.deepEqual(snap.quarterlyUsage, []);
  assertSnapshotConsistent(snap, rig.employees, rig.rewards);
  rig.service.close();
});

test("新尝试先失败、旧尝试迟到成功：最终完成且不退款", async () => {
  const rig = makeRig({ retryDelaysMs: [40, 80] });
  rig.service.redeem("e1", "r1", "red-late");
  await sleep(100); // 三次尝试均已启动
  assert.equal(rig.gate.attemptsOf("red-late").length, 3);

  rig.gate.fail("red-late", 2); // 新尝试先失败
  rig.gate.fail("red-late", 1);
  await sleep(10);
  assert.equal(rig.service.snapshot().redemptions[0].status, "PENDING");

  rig.gate.succeed("red-late", 0); // 旧尝试最后返回成功
  await sleep(10);
  const snap = rig.service.snapshot();
  assert.equal(snap.redemptions[0].status, "COMPLETED");
  assert.equal(snap.employees[0].availablePoints, 900); // 不退款
  assert.equal(snap.rewards[0].availableStock, 9);
  assertSnapshotConsistent(snap, rig.employees, rig.rewards);
  rig.service.close();
});

test("完成后不再启动尝试，迟到回执不改变结果", async () => {
  const rig = makeRig({ retryDelaysMs: [60, 120] });
  rig.service.redeem("e1", "r1", "red-done");
  rig.gate.succeed("red-done", 0); // 第一次即成功
  await sleep(10);
  assert.equal(rig.service.snapshot().redemptions[0].status, "COMPLETED");

  await sleep(200); // 超过全部重试定时
  assert.equal(rig.gate.attemptsOf("red-done").length, 1); // 不再启动

  // 终结后重复取消/查询均不改变结果
  const cancelResult = rig.service.cancel("red-done");
  assert.equal(cancelResult.redemption.status, "COMPLETED");
  const snap = rig.service.snapshot();
  assert.equal(snap.employees[0].availablePoints, 900);
  assert.equal(snap.rewards[0].availableStock, 9);
  assertSnapshotConsistent(snap, rig.employees, rig.rewards);
  rig.service.close();
});
