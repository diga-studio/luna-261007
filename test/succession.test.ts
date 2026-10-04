import test from "node:test";
import assert from "node:assert/strict";
import { computeGap, planSuccession } from "../src/index";
import type { Employee, Position, SuccessionModel } from "../src/index";

const pos = (id: string, required: number, weight = 1, skill = "s"): Position => ({
  id,
  requirements: [{ skill, required, weight }],
});

const emp = (id: string, actual: number, skill = "s"): Employee => ({
  id,
  skills: { [skill]: actual },
});

test("computeGap: 加权万分数缺口、缺失技能按 0、向下取整", () => {
  const position: Position = {
    id: "P",
    requirements: [
      { skill: "a", required: 5, weight: 3 },
      { skill: "b", required: 2, weight: 1 },
      { skill: "c", required: 4, weight: 2 },
    ],
  };
  // 加权要求总和 = 5*3 + 2*1 + 4*2 = 25
  // 员工: a=3(缺2*3=6), b 缺失按0(缺2*1=2), c=5(不缺) => 加权缺口 8
  // gap = floor(10000 * 8 / 25) = 3200
  const employee: Employee = { id: "E", skills: { a: 3, c: 5 } };
  assert.equal(computeGap(position, employee), 3200);
  // actual 超过 required 不产生负缺口
  const over: Employee = { id: "E2", skills: { a: 5, b: 5, c: 5 } };
  assert.equal(computeGap(position, over), 0);
  // 全部缺失: gap = 10000
  const none: Employee = { id: "E3", skills: {} };
  assert.equal(computeGap(position, none), 10000);
});

test("连续争用链: 局部最优会阻断其他岗位, 全局解覆盖全部岗位", () => {
  // P1 <- {E1, E2}, P2 <- {E2, E3}, P3 <- {E3}
  // 若 P1 抢占共享员工 E2、P2 再抢 E3, P3 将空缺;
  // 全局最优为 P1-E1, P2-E2, P3-E3, 覆盖 3 个岗位。
  const model: SuccessionModel = {
    positions: [pos("P1", 3), pos("P2", 3), pos("P3", 3)],
    employees: [emp("E1", 3), emp("E2", 5), emp("E3", 5)],
    candidates: [
      { positionId: "P1", employeeId: "E2", readiness: 0 }, // 局部最优: E2 gap 最小
      { positionId: "P1", employeeId: "E1", readiness: 0 },
      { positionId: "P2", employeeId: "E2", readiness: 0 },
      { positionId: "P2", employeeId: "E3", readiness: 0 },
      { positionId: "P3", employeeId: "E3", readiness: 0 },
    ],
  };
  const plan = planSuccession(model);
  assert.equal(plan.c2, 3);
  assert.equal(plan.c0, 3);
  const pairs = new Map(plan.reservations.map((r) => [r.positionId, r.employeeId]));
  assert.deepEqual(pairs, new Map([["P1", "E1"], ["P2", "E2"], ["P3", "E3"]]));
});

test("字典序优先: 增加 C0 必须牺牲 C2 时, 不放弃当前覆盖", () => {
  // P1 <- {E1(就绪0), E2(就绪2)}, P2 <- {E1(就绪2)}
  // 方案A: P1-E1(0)               => C0=1, C1=1, C2=1
  // 方案B: P1-E2(2), P2-E1(2)     => C0=0, C1=0, C2=2
  // 总覆盖优先会选B, 但字典序要求 C0 最大 => 必须选A。
  const model: SuccessionModel = {
    positions: [pos("P1", 3), pos("P2", 3)],
    employees: [emp("E1", 5), emp("E2", 5)],
    candidates: [
      { positionId: "P1", employeeId: "E1", readiness: 0 },
      { positionId: "P1", employeeId: "E2", readiness: 2 },
      { positionId: "P2", employeeId: "E1", readiness: 2 },
    ],
  };
  const plan = planSuccession(model);
  assert.equal(plan.c0, 1);
  assert.equal(plan.c1, 1);
  assert.equal(plan.c2, 1);
  assert.deepEqual(
    plan.reservations.map((r) => [r.positionId, r.employeeId, r.readiness]),
    [["P1", "E1", 0]],
  );
});

test("就绪级别分层: C1 优先于 C2", () => {
  // P1 <- {E1(就绪1), E2(就绪2)}, P2 <- {E1(就绪2)}
  // 方案A: P1-E1(1)            => C1=1, C2=1
  // 方案B: P1-E2(2), P2-E1(2)  => C1=0, C2=2
  const model: SuccessionModel = {
    positions: [pos("P1", 3), pos("P2", 3)],
    employees: [emp("E1", 5), emp("E2", 5)],
    candidates: [
      { positionId: "P1", employeeId: "E1", readiness: 1 },
      { positionId: "P1", employeeId: "E2", readiness: 2 },
      { positionId: "P2", employeeId: "E1", readiness: 2 },
    ],
  };
  const plan = planSuccession(model);
  assert.equal(plan.c0, 0);
  assert.equal(plan.c1, 1);
  assert.equal(plan.c2, 1);
  assert.deepEqual(
    plan.reservations.map((r) => [r.positionId, r.employeeId]),
    [["P1", "E1"]],
  );
});

test("覆盖数相同: 优先最小化最大 gap, 而非 gap 总和", () => {
  // 两岗位争用同两名员工, 全覆盖方案只有两种:
  // 方案A: P1-E1(gap 0),    P2-E2(gap 8000) => max 8000, sum 8000
  // 方案B: P1-E2(gap 6000), P2-E1(gap 4000) => max 6000, sum 10000
  // 总 gap 更小的是A, 但必须先保护最差岗位 => 选B。
  const model: SuccessionModel = {
    positions: [pos("P1", 5, 1, "s1"), pos("P2", 5, 1, "s2")],
    employees: [
      { id: "E1", skills: { s1: 5, s2: 3 } },
      { id: "E2", skills: { s1: 2, s2: 1 } },
    ],
    candidates: [
      { positionId: "P1", employeeId: "E1", readiness: 0 },
      { positionId: "P1", employeeId: "E2", readiness: 0 },
      { positionId: "P2", employeeId: "E1", readiness: 0 },
      { positionId: "P2", employeeId: "E2", readiness: 0 },
    ],
  };
  const plan = planSuccession(model);
  assert.equal(plan.c2, 2);
  assert.equal(plan.maxGap, 6000);
  assert.equal(plan.totalGap, 10000);
  const pairs = new Map(plan.reservations.map((r) => [r.positionId, r.employeeId]));
  assert.deepEqual(pairs, new Map([["P1", "E2"], ["P2", "E1"]]));
});

test("最大 gap 相同: 再最小化 gap 总和", () => {
  // 方案A: P1-E1(gap 0), P2-E2(gap 6000) => max 6000, sum 6000
  // 方案B: P1-E3(gap 2000), P2-E4(gap 6000) => max 6000, sum 8000
  const model: SuccessionModel = {
    positions: [pos("P1", 5), pos("P2", 5)],
    employees: [emp("E1", 5), emp("E2", 2), emp("E3", 4), emp("E4", 2)],
    candidates: [
      { positionId: "P1", employeeId: "E1", readiness: 0 },
      { positionId: "P1", employeeId: "E3", readiness: 0 },
      { positionId: "P2", employeeId: "E2", readiness: 0 },
      { positionId: "P2", employeeId: "E4", readiness: 0 },
    ],
  };
  const plan = planSuccession(model);
  assert.equal(plan.maxGap, 6000);
  assert.equal(plan.totalGap, 6000);
  const pairs = new Map(plan.reservations.map((r) => [r.positionId, r.employeeId]));
  assert.deepEqual(pairs, new Map([["P1", "E1"], ["P2", "E2"]]));
});

test("约束: 只允许名单内配对, 每岗最多一人, 每人最多一次", () => {
  const model: SuccessionModel = {
    positions: [pos("P1", 5), pos("P2", 5)],
    employees: [emp("E1", 5)],
    candidates: [
      { positionId: "P1", employeeId: "E1", readiness: 0 },
      { positionId: "P2", employeeId: "E1", readiness: 0 },
    ],
  };
  const plan = planSuccession(model);
  assert.equal(plan.c2, 1); // 同一员工不能被预留两次
  assert.equal(plan.reservations.length, 1);
  const r = plan.reservations[0];
  assert.ok(
    model.candidates.some(
      (c) => c.positionId === r.positionId && c.employeeId === r.employeeId,
    ),
  );
});

test("空方案: 无候选人时两个缺口指标均为 0", () => {
  const plan = planSuccession({
    positions: [pos("P1", 5)],
    employees: [emp("E1", 5)],
    candidates: [],
  });
  assert.deepEqual(plan, {
    reservations: [],
    c0: 0,
    c1: 0,
    c2: 0,
    maxGap: 0,
    totalGap: 0,
  });
});
