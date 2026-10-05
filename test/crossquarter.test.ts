import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RedemptionService } from "../src/index.ts";
import { makeRig, assertSnapshotConsistent, sleep, HrGate } from "./helpers.ts";

const Q1 = Date.UTC(2026, 0, 15); // 2026-Q1
const Q2 = Date.UTC(2026, 3, 15); // 2026-Q2

test("跨季度后全部失败：资源只归还一次，释放的是原季度名额", async () => {
  const rig = makeRig({ startTime: Q1, retryDelaysMs: [40, 80] });
  rig.service.redeem("e1", "r1", "red-cross");
  assert.equal(rig.service.snapshot().redemptions[0].quarter, "2026-Q1");

  rig.setTime(Q2); // 跨季度
  await sleep(120); // 三次尝试均已启动
  assert.equal(rig.gate.attemptsOf("red-cross").length, 3);
  rig.gate.fail("red-cross", 0);
  rig.gate.fail("red-cross", 1);
  rig.gate.fail("red-cross", 2);
  await sleep(10);

  const snap = rig.service.snapshot();
  assert.equal(snap.redemptions[0].status, "REJECTED");
  assert.equal(snap.redemptions[0].quarter, "2026-Q1"); // 归属不变
  assert.equal(snap.employees[0].availablePoints, 1000); // 只归还一次
  assert.equal(snap.rewards[0].availableStock, 10);
  assert.deepEqual(snap.quarterlyUsage, []); // 原季度名额已释放，Q2 无占用
  assertSnapshotConsistent(snap, rig.employees, rig.rewards);

  // 原季度名额已释放：Q2 可正常兑换两笔
  assert.equal(rig.service.redeem("e1", "r1", "red-q2-a").accepted, true);
  assert.equal(rig.service.redeem("e1", "r1", "red-q2-b").accepted, true);
  const snap2 = rig.service.snapshot();
  assert.deepEqual(snap2.quarterlyUsage, [
    { employeeId: "e1", rewardId: "r1", quarter: "2026-Q2", used: 2 },
  ]);
  assertSnapshotConsistent(snap2, rig.employees, rig.rewards);
  rig.service.close();
});

test("跨季度后取消：归还资源并释放原季度名额", async () => {
  const rig = makeRig({ startTime: Q1, retryDelaysMs: [5000, 10000] });
  rig.service.redeem("e1", "r1", "red-xq");
  rig.setTime(Q2); // 跨季度后申请取消
  const result = rig.service.cancel("red-xq");
  assert.equal(result.redemption.status, "CANCELLING");

  rig.gate.fail("red-xq", 0);
  await sleep(10);
  const snap = rig.service.snapshot();
  assert.equal(snap.redemptions[0].status, "CANCELLED");
  assert.equal(snap.redemptions[0].quarter, "2026-Q1");
  assert.equal(snap.employees[0].availablePoints, 1000);
  assert.equal(snap.rewards[0].availableStock, 10);
  assert.deepEqual(snap.quarterlyUsage, []);
  assertSnapshotConsistent(snap, rig.employees, rig.rewards);
  rig.service.close();
});

test("跨季度迟到成功：按首次接受时间归属原季度并占用其名额", async () => {
  const rig = makeRig({ startTime: Q1, retryDelaysMs: [5000, 10000] });
  rig.service.redeem("e1", "r1", "red-late-q");
  rig.setTime(Q2);
  rig.gate.succeed("red-late-q", 0);
  await sleep(10);

  const snap = rig.service.snapshot();
  assert.equal(snap.redemptions[0].status, "COMPLETED");
  assert.deepEqual(snap.quarterlyUsage, [
    { employeeId: "e1", rewardId: "r1", quarter: "2026-Q1", used: 1 },
  ]); // 仍占 Q1 名额，Q2 无占用
  assertSnapshotConsistent(snap, rig.employees, rig.rewards);
  rig.service.close();
});

test("SQLite 文件持久化：关闭后重开可读到一致状态", async () => {
  const dir = mkdtempSync(join(tmpdir(), "redemption-"));
  const dbPath = join(dir, "data.sqlite");
  try {
    const gate = new HrGate();
    const service = new RedemptionService(dbPath, gate.action, {
      retryDelaysMs: [5000, 10000],
    });
    service.seed([{ id: "e1", points: 1000 }], [{ id: "r1", price: 100, stock: 5 }]);
    service.redeem("e1", "r1", "red-persist");
    gate.succeed("red-persist", 0);
    await sleep(10);
    service.close();

    assert.ok(existsSync(dbPath));
    const gate2 = new HrGate();
    const reopened = new RedemptionService(dbPath, gate2.action);
    const snap = reopened.snapshot();
    assert.equal(snap.redemptions.length, 1);
    assert.equal(snap.redemptions[0].status, "COMPLETED");
    assert.equal(snap.employees[0].availablePoints, 900);
    assert.equal(snap.rewards[0].availableStock, 4);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
