import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeConfig,
  simulateHyperperiod,
  type TaskSetConfig,
} from "../src/index.js";

const scenarioAAccepted: TaskSetConfig = {
  tasks: [
    { id: "sampler", priority: 0, worstCaseExecutionTime: 50_000, period: 100_000, relativeDeadline: 100_000 },
    { id: "controller", priority: 1, worstCaseExecutionTime: 26_000, period: 75_000, relativeDeadline: 77_000 },
  ],
};

const scenarioARejected: TaskSetConfig = {
  tasks: [
    { id: "sampler", priority: 0, worstCaseExecutionTime: 50_000, period: 100_000, relativeDeadline: 100_000 },
    { id: "controller", priority: 1, worstCaseExecutionTime: 26_000, period: 75_000, relativeDeadline: 76_000 },
  ],
};

/** 恰好 85% 负载，且低优先级任务恰好压线完成 */
const exactUtilizationBoundary: TaskSetConfig = {
  tasks: [
    { id: "a", priority: 0, worstCaseExecutionTime: 50, period: 100, relativeDeadline: 100 },
    { id: "b", priority: 1, worstCaseExecutionTime: 35, period: 100, relativeDeadline: 85 },
  ],
};

/** 截止期限大于周期、存在多实例积压但仍可通过的三任务配置 */
const backlogAccepted: TaskSetConfig = {
  tasks: [
    { id: "fast", priority: 0, worstCaseExecutionTime: 5, period: 50, relativeDeadline: 50 },
    { id: "mid", priority: 1, worstCaseExecutionTime: 10, period: 40, relativeDeadline: 70 },
    { id: "slow", priority: 2, worstCaseExecutionTime: 15, period: 60, relativeDeadline: 100 },
  ],
};

/** 积压导致低优先级任务超时的三任务配置 */
const backlogRejected: TaskSetConfig = {
  tasks: [
    { id: "fast", priority: 0, worstCaseExecutionTime: 6, period: 20, relativeDeadline: 20 },
    { id: "mid", priority: 1, worstCaseExecutionTime: 7, period: 30, relativeDeadline: 30 },
    { id: "slow", priority: 2, worstCaseExecutionTime: 9, period: 50, relativeDeadline: 40 },
  ],
};

const configs: [string, TaskSetConfig][] = [
  ["场景A-通过", scenarioAAccepted],
  ["场景A-拒绝", scenarioARejected],
  ["恰好85%且压线完成", exactUtilizationBoundary],
  ["三任务积压-通过", backlogAccepted],
  ["三任务积压-拒绝", backlogRejected],
];

for (const [name, config] of configs) {
  test(`交叉验证[${name}]：分析结论与覆盖完整重复周期的独立仿真一致`, () => {
    const verdict = analyzeConfig(config);
    const simulation = simulateHyperperiod(config);

    if (verdict.kind === "accepted") {
      // 仿真在整个重复周期内也不存在超时实例
      assert.equal(simulation.firstMiss, undefined, "仿真发现分析未报告的超时实例");
      // 各任务最大响应时间与仿真逐一一致
      assert.equal(verdict.maxResponseTimes.length, config.tasks.length);
      for (const { taskId, maxResponseTime } of verdict.maxResponseTimes) {
        assert.equal(
          simulation.maxResponseTimes.get(taskId),
          maxResponseTime,
          `任务 ${taskId} 的最大响应时间不一致`,
        );
      }
    } else if (verdict.kind === "rejected-deadline") {
      // 仿真同样发现超时
      assert.notEqual(simulation.firstMiss, undefined, "仿真未发现任何超时实例");
      // 分析给出的超时实例必须真实：释放于重复周期内且确实超时
      assert.ok(verdict.miss.releaseTime < simulation.hyperperiod);
      assert.ok(verdict.miss.completionTime > verdict.miss.deadline);
      const task = config.tasks.find((t) => t.id === verdict.miss.taskId);
      assert.equal(
        verdict.miss.deadline - verdict.miss.releaseTime,
        task!.relativeDeadline,
      );
    } else {
      assert.fail("本用例的负载均在 85% 以内，不应因负载被拒");
    }
  });
}

test("交叉验证[场景A-拒绝]：分析与仿真给出同一个真实超时实例", () => {
  const verdict = analyzeConfig(scenarioARejected);
  const simulation = simulateHyperperiod(scenarioARejected);

  assert.equal(verdict.kind, "rejected-deadline");
  assert.deepEqual(simulation.firstMiss, verdict.kind === "rejected-deadline" ? verdict.miss : undefined);
});
