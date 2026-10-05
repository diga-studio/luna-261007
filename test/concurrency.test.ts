import test from "node:test";
import assert from "node:assert/strict";
import { RedemptionService } from "../src/index.ts";
import { makeRig, assertSnapshotConsistent, sleep, HrGate } from "./helpers.ts";

test("并发争抢最后一个库存：只有一笔被接受，失败方资源不变", async () => {
  const rig = makeRig({
    employees: [
      { id: "e1", points: 500 },
      { id: "e2", points: 500 },
    ],
    rewards: [{ id: "r1", price: 100, stock: 1 }],
  });
  // 交错发起（同步临界区保证原子性）
  const results = await Promise.all([
    Promise.resolve().then(() => rig.service.redeem("e1", "r1", "red-s1")),
    Promise.resolve().then(() => rig.service.redeem("e2", "r1", "red-s2")),
  ]);
  const accepted = results.filter((r) => r.accepted);
  const rejected = results.filter((r) => !r.accepted);
  assert.equal(accepted.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason, "OUT_OF_STOCK");

  const snap = rig.service.snapshot();
  assert.equal(snap.rewards[0].availableStock, 0);
  const points = Object.fromEntries(snap.employees.map((e) => [e.id, e.availablePoints]));
  assert.equal(points.e1 + points.e2, 900); // 总共只扣了一笔
  assertSnapshotConsistent(snap, rig.employees, rig.rewards);
  rig.service.close();
});

test("并发争抢最后一个季度名额：只有一笔被接受，失败方资源不变", async () => {
  const rig = makeRig({ employees: [{ id: "e1", points: 1000 }] });
  rig.service.redeem("e1", "r1", "red-q-a"); // 占第1个名额
  const results = await Promise.all([
    Promise.resolve().then(() => rig.service.redeem("e1", "r1", "red-q-b")),
    Promise.resolve().then(() => rig.service.redeem("e1", "r1", "red-q-c")),
  ]);
  const accepted = results.filter((r) => r.accepted);
  const rejected = results.filter((r) => !r.accepted);
  assert.equal(accepted.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason, "QUOTA_EXCEEDED");

  const snap = rig.service.snapshot();
  assert.equal(snap.employees[0].availablePoints, 800); // 只扣两笔
  assert.equal(snap.rewards[0].availableStock, 8);
  assert.deepEqual(snap.quarterlyUsage, [
    { employeeId: "e1", rewardId: "r1", quarter: "2026-Q1", used: 2 },
  ]);
  assertSnapshotConsistent(snap, rig.employees, rig.rewards);
  rig.service.close();
});

test("规模与吞吐：500员工/100奖励，32笔独立兑换首轮HR处理500ms内全部启动", async () => {
  const employees = Array.from({ length: 500 }, (_, i) => ({
    id: `emp-${i}`,
    points: 1000,
  }));
  const rewards = Array.from({ length: 100 }, (_, i) => ({
    id: `rw-${i}`,
    price: 10,
    stock: 50,
  }));
  const gate = new HrGate();
  const service = new RedemptionService(":memory:", gate.action, {
    retryDelaysMs: [5000, 10000],
  });
  service.seed(employees, rewards);

  const start = Date.now();
  for (let i = 0; i < 32; i++) {
    const r = service.redeem(`emp-${i}`, `rw-${i}`, `red-perf-${i}`);
    assert.equal(r.accepted, true);
  }
  const elapsed = Date.now() - start;
  assert.equal(gate.attempts.length, 32); // 首轮尝试全部启动，不等回执
  assert.ok(elapsed < 500, `32 first attempts took ${elapsed}ms`);

  const snap = service.snapshot();
  assert.equal(snap.redemptions.length, 32);
  assertSnapshotConsistent(snap, employees, rewards);
  service.close();
});

test("HR动作持续2秒以上未返回时：提交、取消、快照各在100ms内返回", async () => {
  const gate = new HrGate();
  const service = new RedemptionService(":memory:", gate.action, {
    retryDelaysMs: [5000, 10000],
  });
  service.seed(
    [
      { id: "slow-e", points: 1000 },
      { id: "fast-e", points: 1000 },
    ],
    [{ id: "r1", price: 100, stock: 10 }],
  );
  service.redeem("slow-e", "r1", "red-slow"); // 其 HR 动作 2.5s 后才返回
  const slowResolve = () => gate.succeed("red-slow", 0);
  const slowTimer = setTimeout(slowResolve, 2500);
  slowTimer.unref();

  await sleep(100); // 确保 slow 的 HR 动作仍在挂起

  let t0 = Date.now();
  const r = service.redeem("fast-e", "r1", "red-fast");
  const redeemMs = Date.now() - t0;
  assert.equal(r.accepted, true);
  assert.ok(redeemMs < 100, `redeem took ${redeemMs}ms`);

  t0 = Date.now();
  const c = service.cancel("red-fast");
  const cancelMs = Date.now() - t0;
  assert.equal(c.redemption.status, "CANCELLING"); // 返回不代表取消已终结
  assert.ok(cancelMs < 100, `cancel took ${cancelMs}ms`);

  t0 = Date.now();
  const snap = service.snapshot();
  const snapMs = Date.now() - t0;
  assert.ok(snapMs < 100, `snapshot took ${snapMs}ms`);
  assert.equal(
    snap.redemptions.find((x) => x.id === "red-slow")!.status,
    "PENDING",
  );

  // 等待慢动作返回后，状态正确推进
  await sleep(2600);
  const after = service.snapshot();
  assert.equal(after.redemptions.find((x) => x.id === "red-slow")!.status, "COMPLETED");
  service.close();
});
