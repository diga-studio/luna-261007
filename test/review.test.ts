import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ReviewService } from "../src/index.js";

const DAY = 24 * 60 * 60 * 1000;
const CYCLE = 14 * DAY;
const T0 = 1_700_000_000_000;

function makeService(): ReviewService {
  return new ReviewService(openDatabase(":memory:"));
}

test("两个周期都逾期：确认一个仍挂起，确认最后一个恢复；截止边界精确", () => {
  const svc = makeService();
  const g = svc.grant("alice", "db1", "reader", T0);
  const cycleA = svc.openCycle("db1", T0);
  const cycleB = svc.openCycle("db1", T0 + DAY);
  const [itemA] = svc.listCycleItems(cycleA.id);
  const [itemB] = svc.listCycleItems(cycleB.id);
  assert.equal(itemA.grantId, g.id);
  assert.equal(itemB.grantId, g.id);

  // 截止前一毫秒：仍可用
  const before = svc.getGrantAvailability(g.id, cycleA.deadline - 1);
  assert.equal(before.status, "active");

  // 截止瞬间：立即挂起（无需后台任务）
  const at = svc.getGrantAvailability(g.id, cycleA.deadline);
  assert.equal(at.status, "suspended");
  assert.deepEqual(at.suspendingItemIds, [itemA.id]);

  // 两个周期都已逾期
  const both = svc.getGrantAvailability(g.id, cycleB.deadline);
  assert.equal(both.status, "suspended");
  assert.deepEqual(
    [...both.suspendingItemIds].sort(),
    [itemA.id, itemB.id].sort(),
  );

  // 确认其中一个：另一个周期的逾期待审仍然挂起该实例
  svc.submitDecisions([{ itemId: itemA.id, decision: "confirm" }], cycleB.deadline);
  const stillSuspended = svc.getGrantAvailability(g.id, cycleB.deadline);
  assert.equal(stillSuspended.status, "suspended");
  assert.deepEqual(stillSuspended.suspendingItemIds, [itemB.id]);

  // 确认最后一个：恢复可用
  svc.submitDecisions([{ itemId: itemB.id, decision: "confirm" }], cycleB.deadline);
  const restored = svc.getGrantAvailability(g.id, cycleB.deadline);
  assert.equal(restored.status, "active");
  assert.deepEqual(restored.suspendingItemIds, []);
});

test("撤销后重授：旧周期的确认/撤销不影响新实例，旧实例保持撤销", () => {
  const svc = makeService();
  const g1 = svc.grant("alice", "db1", "reader", T0);
  const cycleA = svc.openCycle("db1", T0);
  const cycleB = svc.openCycle("db1", T0 + DAY);
  const [itemA] = svc.listCycleItems(cycleA.id);
  const [itemB] = svc.listCycleItems(cycleB.id);

  // 周期 A 撤销授权
  svc.submitDecisions([{ itemId: itemA.id, decision: "revoke" }], T0 + 2 * DAY);
  assert.equal(svc.getGrantAvailability(g1.id, T0 + 2 * DAY).status, "revoked");

  // 重新授予：独立新实例，且不补入旧周期
  const g2 = svc.grant("alice", "db1", "reader", T0 + 3 * DAY);
  assert.notEqual(g2.id, g1.id);
  assert.equal(svc.listCycleItems(cycleA.id).length, 1);
  assert.equal(svc.listCycleItems(cycleB.id).length, 1);

  // 旧周期提交确认：新实例不受影响，旧实例保持撤销
  svc.submitDecisions([{ itemId: itemB.id, decision: "confirm" }], T0 + 4 * DAY);
  assert.equal(svc.getGrantAvailability(g1.id, T0 + 4 * DAY).status, "revoked");
  assert.equal(svc.getGrantAvailability(g2.id, T0 + 4 * DAY).status, "active");

  // 旧实例始终撤销，即使时间越过所有截止
  assert.equal(
    svc.getGrantAvailability(g1.id, T0 + 30 * DAY).status,
    "revoked",
  );
  assert.equal(
    svc.getGrantAvailability(g2.id, T0 + 30 * DAY).status,
    "active",
  );
});

test("旧周期的撤销决定也不影响重授的新实例", () => {
  const svc = makeService();
  const g1 = svc.grant("alice", "db1", "reader", T0);
  const cycleA = svc.openCycle("db1", T0);
  const cycleB = svc.openCycle("db1", T0 + DAY);
  const [itemA] = svc.listCycleItems(cycleA.id);
  const [itemB] = svc.listCycleItems(cycleB.id);

  svc.submitDecisions([{ itemId: itemA.id, decision: "revoke" }], T0 + 2 * DAY);
  const g2 = svc.grant("alice", "db1", "reader", T0 + 3 * DAY);

  // 旧周期对旧实例再提交撤销（逾期后仍可决定）
  svc.submitDecisions(
    [{ itemId: itemB.id, decision: "revoke" }],
    cycleB.deadline + DAY,
  );
  assert.equal(
    svc.getGrantAvailability(g1.id, cycleB.deadline + DAY).status,
    "revoked",
  );
  assert.equal(
    svc.getGrantAvailability(g2.id, cycleB.deadline + DAY).status,
    "active",
  );
});

test("同一组合最多一个未撤销实例；挂起不能通过再次授予绕过", () => {
  const svc = makeService();
  const g = svc.grant("alice", "db1", "reader", T0);
  // 未撤销时重复授予失败
  assert.throws(() => svc.grant("alice", "db1", "reader", T0), /unrevoked/);
  // 挂起后（周期逾期）仍不能再次授予
  svc.openCycle("db1", T0);
  assert.throws(
    () => svc.grant("alice", "db1", "reader", T0 + CYCLE),
    /unrevoked/,
  );
  assert.equal(
    svc.getGrantAvailability(g.id, T0 + CYCLE).status,
    "suspended",
  );
  // 不同组合不受影响
  assert.ok(svc.grant("alice", "db1", "writer", T0 + CYCLE));
});

test("周期快照：开启后新授权不补入；已挂起实例仍被纳入", () => {
  const svc = makeService();
  const g1 = svc.grant("alice", "db1", "reader", T0);
  const cycleA = svc.openCycle("db1", T0);
  // g1 逾期挂起后开启周期 B：仍纳入 g1
  const cycleB = svc.openCycle("db1", T0 + CYCLE);
  assert.equal(
    svc.getGrantAvailability(g1.id, T0 + CYCLE).status,
    "suspended",
  );
  const itemsB = svc.listCycleItems(cycleB.id);
  assert.equal(itemsB.length, 1);
  assert.equal(itemsB[0].grantId, g1.id);
  // 新授权不补入旧周期
  const g2 = svc.grant("bob", "db1", "reader", T0 + CYCLE);
  assert.equal(svc.listCycleItems(cycleA.id).length, 1);
  assert.equal(svc.listCycleItems(cycleB.id).length, 1);
  // 其他数据库的授权不被纳入
  svc.grant("carol", "db2", "reader", T0 + CYCLE);
  assert.equal(svc.listCycleItems(cycleB.id).length, 1);
  assert.ok(g2);
});

test("批次原子性：相反决定导致整个批次失败且无任何变化", () => {
  const svc = makeService();
  const g1 = svc.grant("alice", "db1", "reader", T0);
  const g2 = svc.grant("bob", "db1", "reader", T0);
  const cycle = svc.openCycle("db1", T0);
  const [item1, item2] = svc.listCycleItems(cycle.id);
  assert.equal(item1.grantId, g1.id);
  assert.equal(item2.grantId, g2.id);

  // 先确认 item1
  svc.submitDecisions([{ itemId: item1.id, decision: "confirm" }], T0 + DAY);
  // 批次中试图把 item1 改成相反决定：整个批次失败，item2 的撤销也不生效
  assert.throws(
    () =>
      svc.submitDecisions(
        [
          { itemId: item2.id, decision: "revoke" },
          { itemId: item1.id, decision: "revoke" },
        ],
        T0 + 2 * DAY,
      ),
    /already confirmed/,
  );
  const items = svc.listCycleItems(cycle.id);
  assert.equal(items[0].status, "confirmed");
  assert.equal(items[1].status, "pending");
  assert.equal(svc.getGrantAvailability(g2.id, T0 + 2 * DAY).status, "active");

  // 同一批次内对同一条目的相反决定同样整体失败
  assert.throws(
    () =>
      svc.submitDecisions(
        [
          { itemId: item2.id, decision: "confirm" },
          { itemId: item2.id, decision: "revoke" },
        ],
        T0 + 3 * DAY,
      ),
    /already confirmed/,
  );
  assert.equal(svc.listCycleItems(cycle.id)[1].status, "pending");
});

test("重复提交相同决定幂等成功，不产生额外变化", () => {
  const svc = makeService();
  svc.grant("alice", "db1", "reader", T0);
  const cycle = svc.openCycle("db1", T0);
  const [item] = svc.listCycleItems(cycle.id);

  svc.submitDecisions([{ itemId: item.id, decision: "confirm" }], T0 + DAY);
  const decidedAt = svc.listCycleItems(cycle.id)[0].decidedAt;
  // 跨周期批次中重复同一决定：成功且 decidedAt 不变
  svc.submitDecisions(
    [
      { itemId: item.id, decision: "confirm" },
      { itemId: item.id, decision: "confirm" },
    ],
    T0 + 2 * DAY,
  );
  const after = svc.listCycleItems(cycle.id)[0];
  assert.equal(after.status, "confirmed");
  assert.equal(after.decidedAt, decidedAt);
});

test("撤销决定永久撤销实例，其他周期的确认不得恢复", () => {
  const svc = makeService();
  const g = svc.grant("alice", "db1", "reader", T0);
  const cycleA = svc.openCycle("db1", T0);
  const cycleB = svc.openCycle("db1", T0 + DAY);
  const [itemA] = svc.listCycleItems(cycleA.id);
  const [itemB] = svc.listCycleItems(cycleB.id);

  svc.submitDecisions([{ itemId: itemA.id, decision: "revoke" }], T0 + 2 * DAY);
  svc.submitDecisions([{ itemId: itemB.id, decision: "confirm" }], T0 + 3 * DAY);
  assert.equal(svc.getGrantAvailability(g.id, T0 + 3 * DAY).status, "revoked");
});

test("调用方时钟回退被拒绝", () => {
  const svc = makeService();
  svc.grant("alice", "db1", "reader", T0);
  assert.throws(() => svc.grant("bob", "db1", "reader", T0 - 1), /regressed/);
});
