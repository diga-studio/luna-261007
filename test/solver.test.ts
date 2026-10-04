import { test } from "node:test";
import assert from "node:assert/strict";
import { solveAllocation } from "../src/index.js";
import type { AllocationRequest, AllocationPlan } from "../src/index.js";

/**
 * 场景一：必须“有减有增”才能跨过评分门槛。
 * 当前：A=3, B=4, C=5，总人数 12，总评分 15，目标 20。
 * 精确答案（手工枚举）：
 *   A 3→5（+7 分，30 分费用），C 5→3（-1 分，8 分费用）
 *   总分 21，总费用 38，改动 2 个科室。
 * 次优：A 3→5 + B 4→2，总分 21，费用 40。
 */
const shiftScenario: AllocationRequest = {
  targetScore: 20,
  departments: [
    {
      id: "A",
      currentNurses: 3,
      candidates: [
        { nurses: 3, score: 5, cost: 0 },
        { nurses: 5, score: 12, cost: 30 },
      ],
    },
    {
      id: "B",
      currentNurses: 4,
      candidates: [
        { nurses: 2, score: 4, cost: 10 },
        { nurses: 4, score: 5, cost: 0 },
        { nurses: 6, score: 9, cost: 25 },
      ],
    },
    {
      id: "C",
      currentNurses: 5,
      candidates: [
        { nurses: 3, score: 4, cost: 8 },
        { nurses: 5, score: 5, cost: 0 },
      ],
    },
  ],
};

test("有减有增才能达标：可达性、最低费用、最少改动数与精确答案一致", () => {
  const result = solveAllocation(shiftScenario);
  assert.equal(result.feasible, true);
  const plan = result as AllocationPlan;
  assert.equal(plan.totalScore, 21);
  assert.equal(plan.totalCost, 38);
  assert.equal(plan.changedDepartments, 2);
  assert.deepEqual(
    plan.changes.map((c) => [c.id, c.fromNurses, c.toNurses, c.scoreDelta, c.cost]),
    [
      ["A", 3, 5, 7, 30],
      ["C", 5, 3, -1, 8],
    ],
  );
  // 人数守恒：改动之和为 0。
  const delta = plan.changes.reduce((sum, c) => sum + (c.toNurses - c.fromNurses), 0);
  assert.equal(delta, 0);
});

test("解释与最终组合一致：包含每个改动科室与最终总分", () => {
  const plan = solveAllocation(shiftScenario) as AllocationPlan;
  assert.match(plan.explanation, /A：3 → 5 人（\+2），贡献分 \+7，调整费用 30 分/);
  assert.match(plan.explanation, /C：5 → 3 人（-2），贡献分 \+0?-?1?/);
  assert.match(plan.explanation, /调整后总分 21 ≥ 目标 20；总费用 38 分，涉及 2 个科室/);
});

test("接近但未达标不能算作成功：目标 22 时明确不可达", () => {
  const result = solveAllocation({ ...shiftScenario, targetScore: 22 });
  assert.equal(result.feasible, false);
  if (!result.feasible) {
    assert.match(result.reason, /不可达|没有任何候选组合/);
  }
});

test("锁定科室使原本可达的目标变为不可达", () => {
  // 锁 B：仍可达，但只能走 A+C 方案（费用 38 不变，因为 C 方案本就最低）。
  // 锁 C：只能走 A+B 方案，费用升至 40。
  const lockC = solveAllocation({
    ...shiftScenario,
    departments: shiftScenario.departments.map((d) =>
      d.id === "C" ? { ...d, locked: true } : d,
    ),
  }) as AllocationPlan;
  assert.equal(lockC.feasible, true);
  assert.equal(lockC.totalCost, 40);
  assert.equal(lockC.changedDepartments, 2);

  // 同时锁 B 和 C：A 增加的人无处补回，人数守恒无法满足，目标不可达。
  const lockBC = solveAllocation({
    ...shiftScenario,
    departments: shiftScenario.departments.map((d) =>
      d.id === "A" ? d : { ...d, locked: true },
    ),
  });
  assert.equal(lockBC.feasible, false);
});

test("当前配置已达标时返回不作调整的建议", () => {
  const plan = solveAllocation({ ...shiftScenario, targetScore: 15 }) as AllocationPlan;
  assert.equal(plan.feasible, true);
  assert.equal(plan.totalScore, 15);
  assert.equal(plan.totalCost, 0);
  assert.equal(plan.changedDepartments, 0);
  assert.deepEqual(plan.changes, []);
  assert.match(plan.explanation, /无需调整/);
});

test("费用相同时选择改动科室数更少的组合", () => {
  // A+B 方案：费用 40，改动 2 个科室；A+B+C+D 方案：费用 40，改动 4 个科室。
  const plan = solveAllocation({
    targetScore: 24,
    departments: [
      {
        id: "A",
        currentNurses: 3,
        candidates: [
          { nurses: 3, score: 5, cost: 0 },
          { nurses: 5, score: 10, cost: 40 },
        ],
      },
      {
        id: "B",
        currentNurses: 4,
        candidates: [
          { nurses: 2, score: 4, cost: 0 },
          { nurses: 4, score: 5, cost: 0 },
        ],
      },
      {
        id: "C",
        currentNurses: 5,
        candidates: [
          { nurses: 5, score: 5, cost: 0 },
          { nurses: 7, score: 8, cost: 0 },
        ],
      },
      {
        id: "D",
        currentNurses: 6,
        candidates: [
          { nurses: 4, score: 4, cost: 0 },
          { nurses: 6, score: 5, cost: 0 },
        ],
      },
    ],
  }) as AllocationPlan;
  assert.equal(plan.feasible, true);
  assert.equal(plan.totalCost, 40);
  assert.equal(plan.changedDepartments, 2);
});

test("目标远超可达范围时返回不可达", () => {
  const result = solveAllocation({ ...shiftScenario, targetScore: 100 });
  assert.equal(result.feasible, false);
});

test("非法输入抛出错误", () => {
  const base = shiftScenario.departments;
  assert.throws(
    () =>
      solveAllocation({
        targetScore: 20,
        departments: [{ ...base[0], currentNurses: 4 }],
      }),
    /不在候选中/,
  );
  assert.throws(
    () =>
      solveAllocation({
        targetScore: 20,
        departments: [
          {
            id: "X",
            currentNurses: 2,
            candidates: [
              { nurses: 2, score: 5, cost: 0 },
              { nurses: 2, score: 6, cost: 3 },
            ],
          },
        ],
      }),
    /重复/,
  );
  assert.throws(
    () =>
      solveAllocation({
        targetScore: 20,
        departments: [
          {
            id: "X",
            currentNurses: 2,
            candidates: [
              { nurses: 2, score: 5, cost: 0 },
              { nurses: 3, score: 4, cost: 3 },
            ],
          },
        ],
      }),
    /不能下降/,
  );
  assert.throws(
    () =>
      solveAllocation({
        targetScore: 20,
        departments: [
          {
            id: "X",
            currentNurses: 2,
            candidates: [
              { nurses: 2, score: 5, cost: 0 },
              { nurses: 3, score: 6, cost: -1 },
            ],
          },
        ],
      }),
    /不能为负/,
  );
  assert.throws(
    () => solveAllocation({ targetScore: 20.5, departments: base }),
    /整数/,
  );
});
