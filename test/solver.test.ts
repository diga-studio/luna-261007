import { test } from "node:test";
import assert from "node:assert/strict";
import { suggestStaffing } from "../src/solver.ts";
import type { DepartmentInput } from "../src/types.ts";

/**
 * 场景一：必须同时减少某些科室、增加另一些科室才能跨过评分门槛。
 * 四个科室当前各 2 人，当前总分 20，目标 30（需 +10）。
 * 唯一净人数守恒且达标的组合：B 增 2 人（+11 分，费用 9），D 减 2 人（-1 分，费用 1）。
 */
function scenario1(): DepartmentInput[] {
  return [
    {
      id: "A",
      currentHeadcount: 2,
      candidates: [
        { headcount: 2, score: 5, cost: 0 },
        { headcount: 0, score: 2, cost: 4 },
        { headcount: 4, score: 6, cost: 3 },
      ],
    },
    {
      id: "B",
      currentHeadcount: 2,
      candidates: [
        { headcount: 2, score: 5, cost: 0 },
        { headcount: 0, score: 1, cost: 5 },
        { headcount: 4, score: 16, cost: 9 },
      ],
    },
    {
      id: "C",
      currentHeadcount: 2,
      candidates: [
        { headcount: 2, score: 5, cost: 0 },
        { headcount: 0, score: 3, cost: 2 },
        { headcount: 4, score: 7, cost: 20 },
      ],
    },
    {
      id: "D",
      currentHeadcount: 2,
      candidates: [
        { headcount: 2, score: 5, cost: 0 },
        { headcount: 0, score: 4, cost: 1 },
        { headcount: 4, score: 5, cost: 2 },
      ],
    },
  ];
}

test("跨门槛：有增有减才可达，最低费用与最少改动数与精确答案一致", () => {
  const advice = suggestStaffing(scenario1(), 30);
  assert.equal(advice.reachable, true);
  assert.equal(advice.totalScore, 30);
  assert.equal(advice.totalCost, 10);
  assert.equal(advice.changedDepartments, 2);

  const byId = new Map(advice.changes.map((c) => [c.departmentId, c]));
  assert.equal(byId.size, 2);
  assert.deepEqual(byId.get("B"), {
    departmentId: "B",
    fromHeadcount: 2,
    toHeadcount: 4,
    scoreGain: 11,
    cost: 9,
  });
  assert.deepEqual(byId.get("D"), {
    departmentId: "D",
    fromHeadcount: 2,
    toHeadcount: 0,
    scoreGain: -1,
    cost: 1,
  });

  // 解释与最终组合一致：人数守恒、费用与改动数吻合、摘要提到改动科室
  const delta = advice.changes.reduce((s, c) => s + c.toHeadcount - c.fromHeadcount, 0);
  assert.equal(delta, 0);
  assert.equal(advice.changes.reduce((s, c) => s + c.cost, 0), advice.totalCost);
  assert.ok(advice.summary.includes("B"));
  assert.ok(advice.summary.includes("D"));
});

test("同一场景目标 31 不可达，不能拿接近目标的配置冒充成功", () => {
  const advice = suggestStaffing(scenario1(), 31);
  assert.equal(advice.reachable, false);
  assert.equal(advice.changes.length, 0);
  assert.ok(advice.summary.includes("不可达"));
});

test("锁定科室使原本可达的目标变为不可达", () => {
  const locked = scenario1().map((d) => (d.id === "D" ? { ...d, locked: true } : d));
  const advice = suggestStaffing(locked, 30);
  assert.equal(advice.reachable, false);
});

test("当前配置已达标时返回不作调整的建议", () => {
  const advice = suggestStaffing(scenario1(), 20);
  assert.equal(advice.reachable, true);
  assert.equal(advice.totalScore, 20);
  assert.equal(advice.totalCost, 0);
  assert.equal(advice.changedDepartments, 0);
  assert.equal(advice.changes.length, 0);
});

/**
 * 场景二：费用相同时选改动科室数更少的组合。
 * 组合一：P 增 2（+10，费用 6）+ Q 减 2（费用 4），共 2 个科室、费用 10。
 * 组合二：R 增 2（+6，费用 3）+ S 增 2（+4，费用 3）+ T 减 4（费用 4），共 3 个科室、费用 10。
 */
function scenario2(): DepartmentInput[] {
  return [
    {
      id: "P",
      currentHeadcount: 2,
      candidates: [
        { headcount: 2, score: 0, cost: 0 },
        { headcount: 4, score: 10, cost: 6 },
      ],
    },
    {
      id: "Q",
      currentHeadcount: 2,
      candidates: [
        { headcount: 2, score: 0, cost: 0 },
        { headcount: 0, score: 0, cost: 4 },
      ],
    },
    {
      id: "R",
      currentHeadcount: 2,
      candidates: [
        { headcount: 2, score: 0, cost: 0 },
        { headcount: 4, score: 6, cost: 3 },
      ],
    },
    {
      id: "S",
      currentHeadcount: 2,
      candidates: [
        { headcount: 2, score: 0, cost: 0 },
        { headcount: 4, score: 4, cost: 3 },
      ],
    },
    {
      id: "T",
      currentHeadcount: 4,
      candidates: [
        { headcount: 4, score: 0, cost: 0 },
        { headcount: 0, score: 0, cost: 4 },
      ],
    },
  ];
}

test("费用相同时优先改动科室数更少的组合", () => {
  const advice = suggestStaffing(scenario2(), 10);
  assert.equal(advice.reachable, true);
  assert.equal(advice.totalCost, 10);
  assert.equal(advice.changedDepartments, 2);
  const ids = advice.changes.map((c) => c.departmentId).sort();
  assert.deepEqual(ids, ["P", "Q"]);
});

test("输入校验：当前人数不在候选集合中时报错", () => {
  const bad: DepartmentInput[] = [
    {
      id: "X",
      currentHeadcount: 3,
      candidates: [{ headcount: 2, score: 1, cost: 0 }],
    },
  ];
  assert.throws(() => suggestStaffing(bad, 1), /当前人数不在候选集合中/);
});
