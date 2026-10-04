import assert from "node:assert/strict";
import test from "node:test";
import { analyzeConfig } from "../src/index.js";
import type { TaskSetConfig } from "../src/index.js";

const MS = 1000;

/** 题目给定场景：优先级 0 任务 50/100/100ms，优先级 1 任务 26/75/76ms。 */
function scenarioConfig(deadlineMs: number): TaskSetConfig {
  return {
    tasks: [
      {
        id: "high",
        priority: 0,
        worstCaseExecutionTime: 50 * MS,
        period: 100 * MS,
        relativeDeadline: 100 * MS,
      },
      {
        id: "low",
        priority: 1,
        worstCaseExecutionTime: 26 * MS,
        period: 75 * MS,
        relativeDeadline: deadlineMs * MS,
      },
    ],
  };
}

test("负载合格但低优先级任务第二次释放超时，必须拒绝并给出真实超时实例", () => {
  const result = analyzeConfig(scenarioConfig(76));
  assert.equal(result.verdict, "rejected-deadline");
  assert.ok(result.utilization.numerator * 100n < 85n * result.utilization.denominator);
  if (result.verdict !== "rejected-deadline") return;
  // 第二次释放于 75ms，完成于 152ms，截止时刻为 151ms。
  assert.deepEqual(result.miss, {
    taskId: "low",
    releaseTime: 75 * MS,
    absoluteDeadline: 151 * MS,
    completionTime: 152 * MS,
  });
});

test("截止期限放宽到 77ms 后通过，最大响应时间为 77ms", () => {
  const result = analyzeConfig(scenarioConfig(77));
  assert.equal(result.verdict, "accepted");
  if (result.verdict !== "accepted") return;
  assert.equal(result.maxResponseTimes.low, 77 * MS);
  assert.equal(result.maxResponseTimes.high, 50 * MS);
});

test("负载恰好 85% 时允许继续检查并按截止期限判定", () => {
  const result = analyzeConfig({
    tasks: [
      { id: "a", priority: 0, worstCaseExecutionTime: 1, period: 2, relativeDeadline: 2 },
      { id: "b", priority: 1, worstCaseExecutionTime: 7, period: 20, relativeDeadline: 20 },
    ],
  });
  assert.equal(result.verdict, "accepted");
  assert.equal(result.utilization.numerator, 17n);
  assert.equal(result.utilization.denominator, 20n);
});

test("负载超过 85% 直接拒绝，只说明负载原因", () => {
  const result = analyzeConfig({
    tasks: [
      { id: "a", priority: 0, worstCaseExecutionTime: 1, period: 2, relativeDeadline: 2 },
      { id: "b", priority: 1, worstCaseExecutionTime: 8, period: 20, relativeDeadline: 20 },
    ],
  });
  assert.equal(result.verdict, "rejected-utilization");
  if (result.verdict !== "rejected-utilization") return;
  assert.match(result.reason, /负载/);
  assert.match(result.reason, /9\/10/);
});

test("恰好在截止时刻完成算成功", () => {
  const result = analyzeConfig({
    tasks: [
      { id: "a", priority: 0, worstCaseExecutionTime: 3, period: 10, relativeDeadline: 10 },
      { id: "b", priority: 1, worstCaseExecutionTime: 7, period: 20, relativeDeadline: 10 },
    ],
  });
  assert.equal(result.verdict, "accepted");
  if (result.verdict !== "accepted") return;
  assert.equal(result.maxResponseTimes.b, 10);
});

test("非法配置抛出说明性错误", () => {
  const base = { id: "a", priority: 0, worstCaseExecutionTime: 1, period: 2, relativeDeadline: 2 };
  assert.throws(
    () => analyzeConfig({ tasks: [base, { ...base, priority: 1 }] }),
    /id/,
  );
  assert.throws(
    () =>
      analyzeConfig({
        tasks: [
          { ...base, id: "a" },
          { ...base, id: "b" },
        ],
      }),
    /priority/,
  );
  assert.throws(
    () => analyzeConfig({ tasks: [{ ...base, id: "a", period: 0 }] }),
    /period/,
  );
  assert.throws(
    () => analyzeConfig({ tasks: [{ ...base, id: "a", worstCaseExecutionTime: 1.5 }] }),
    /worstCaseExecutionTime/,
  );
});
