import assert from "node:assert/strict";
import test from "node:test";
import { analyzeConfig, type TaskSetConfig } from "../src/index.js";

/**
 * 题目给定场景（单位换算为微秒）：
 * 优先级 0：执行 50ms、周期 100ms、截止 100ms
 * 优先级 1：执行 26ms、周期 75ms、截止 76ms（或 77ms）
 */
function scenarioA(lowPriorityDeadlineUs: number): TaskSetConfig {
  return {
    tasks: [
      {
        id: "sampler",
        priority: 0,
        worstCaseExecutionTime: 50_000,
        period: 100_000,
        relativeDeadline: 100_000,
      },
      {
        id: "controller",
        priority: 1,
        worstCaseExecutionTime: 26_000,
        period: 75_000,
        relativeDeadline: lowPriorityDeadlineUs,
      },
    ],
  };
}

test("负载低于85%但低优先级任务第二次释放超时，必须拒绝并给出真实超时实例", () => {
  const verdict = analyzeConfig(scenarioA(76_000));

  assert.equal(verdict.kind, "rejected-deadline");
  // 负载 = 1/2 + 26/75 = 127/150 ≈ 84.67% < 85%，负载门限本身合格
  assert.equal(verdict.utilizationNumerator, 127n);
  assert.equal(verdict.utilizationDenominator, 150n);
  // 低优先级任务首次响应 76ms 恰好达标；第二次释放于 75ms、完成于 152ms，
  // 绝对截止时刻 75ms + 76ms = 151ms，超时 1ms
  assert.deepEqual(verdict.miss, {
    taskId: "controller",
    releaseTime: 75_000,
    completionTime: 152_000,
    deadline: 151_000,
  });
});

test("截止期限改为77ms后必须通过，报告最大响应时间77ms", () => {
  const verdict = analyzeConfig(scenarioA(77_000));

  assert.equal(verdict.kind, "accepted");
  assert.deepEqual(verdict.maxResponseTimes, [
    { taskId: "sampler", maxResponseTime: 50_000 },
    { taskId: "controller", maxResponseTime: 77_000 },
  ]);
});

test("总负载恰好85%允许继续检查（精确比例边界）", () => {
  // 1/2 + 7/20 = 17/20 = 85%，且各实例均能按时完成
  const verdict = analyzeConfig({
    tasks: [
      { id: "a", priority: 0, worstCaseExecutionTime: 50, period: 100, relativeDeadline: 100 },
      { id: "b", priority: 1, worstCaseExecutionTime: 35, period: 100, relativeDeadline: 100 },
    ],
  });

  assert.equal(verdict.kind, "accepted");
  assert.equal(verdict.utilizationNumerator, 17n);
  assert.equal(verdict.utilizationDenominator, 20n);
});

test("负载超过85%直接拒绝，仅说明负载原因", () => {
  // 1/2 + 35001/100000 = 0.85001 > 0.85
  const verdict = analyzeConfig({
    tasks: [
      { id: "a", priority: 0, worstCaseExecutionTime: 50, period: 100, relativeDeadline: 100 },
      { id: "b", priority: 1, worstCaseExecutionTime: 35_001, period: 100_000, relativeDeadline: 100_000 },
    ],
  });

  assert.equal(verdict.kind, "rejected-utilization");
  assert.equal("miss" in verdict, false);
  assert.equal("maxResponseTimes" in verdict, false);
});

test("单任务恰好85%负载通过门限，多1微秒即拒绝（整数精确边界）", () => {
  const atLimit = analyzeConfig({
    tasks: [{ id: "a", priority: 0, worstCaseExecutionTime: 85_000, period: 100_000, relativeDeadline: 100_000 }],
  });
  assert.equal(atLimit.kind, "accepted");

  const overLimit = analyzeConfig({
    tasks: [{ id: "a", priority: 0, worstCaseExecutionTime: 85_001, period: 100_000, relativeDeadline: 100_000 }],
  });
  assert.equal(overLimit.kind, "rejected-utilization");
});

test("恰好在截止时刻完成算成功", () => {
  // 低优先级实例完成时刻恰好等于绝对截止时刻（场景A首个实例：76ms 完成、76ms 截止）
  // 需同时抬高第二实例的截止，故直接构造：完成时刻 == 截止时刻
  const verdict = analyzeConfig({
    tasks: [
      { id: "a", priority: 0, worstCaseExecutionTime: 30, period: 100, relativeDeadline: 100 },
      { id: "b", priority: 1, worstCaseExecutionTime: 20, period: 100, relativeDeadline: 50 },
    ],
  });
  // b 的响应时间 = 20 + 30 = 50，恰好等于截止期限
  assert.equal(verdict.kind, "accepted");
  assert.deepEqual(verdict.maxResponseTimes, [
    { taskId: "a", maxResponseTime: 30 },
    { taskId: "b", maxResponseTime: 50 },
  ]);
});

test("非法输入被拒绝：重复标识、重复优先级、非正整数时间", () => {
  const base = { id: "a", priority: 0, worstCaseExecutionTime: 10, period: 100, relativeDeadline: 100 };
  assert.throws(() =>
    analyzeConfig({ tasks: [base, { ...base, id: "a", priority: 1 }] }),
  );
  assert.throws(() =>
    analyzeConfig({ tasks: [base, { ...base, id: "b", priority: 0 }] }),
  );
  assert.throws(() =>
    analyzeConfig({ tasks: [{ ...base, worstCaseExecutionTime: 0 }] }),
  );
  assert.throws(() =>
    analyzeConfig({ tasks: [{ ...base, period: 100.5 }] }),
  );
});
