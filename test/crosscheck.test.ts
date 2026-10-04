import assert from "node:assert/strict";
import test from "node:test";
import { analyzeConfig } from "../src/index.js";
import type { TaskSetConfig, TaskSpec } from "../src/index.js";

interface ReferenceOutcome {
  readonly maxResponseTimes: Readonly<Record<string, number>>;
  readonly firstMiss: { readonly taskId: string; readonly releaseTime: number; readonly completionTime: number } | null;
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/**
 * 独立的参考实现：按 1 微秒步长朴素推进，覆盖整数个完整超周期，
 * 并继续运行至参考窗口内释放的所有实例全部完成。
 */
function referenceSimulate(tasks: readonly TaskSpec[], hyperperiods: number): ReferenceOutcome {
  const sorted = [...tasks].sort((a, b) => a.priority - b.priority);
  let hyperperiod = 1;
  for (const task of sorted) {
    hyperperiod = (hyperperiod / gcd(hyperperiod, task.period)) * task.period;
  }
  const horizon = hyperperiod * hyperperiods;
  const queues = sorted.map(() => [] as { release: number; remaining: number }[]);
  const nextRelease = sorted.map(() => 0);
  const maxResponse = new Map<string, number>();
  let firstMiss: ReferenceOutcome["firstMiss"] = null;
  for (let t = 0; ; t += 1) {
    if (t < horizon) {
      for (let i = 0; i < sorted.length; i += 1) {
        if (nextRelease[i] === t) {
          queues[i].push({ release: t, remaining: sorted[i].worstCaseExecutionTime });
          nextRelease[i] += sorted[i].period;
        }
      }
    } else if (queues.every((q) => q.length === 0)) {
      break;
    }
    const running = queues.findIndex((q) => q.length > 0);
    if (running < 0) continue;
    const job = queues[running][0];
    job.remaining -= 1;
    if (job.remaining > 0) continue;
    queues[running].shift();
    const task = sorted[running];
    const response = t + 1 - job.release;
    maxResponse.set(task.id, Math.max(maxResponse.get(task.id) ?? 0, response));
    if (firstMiss === null && response > task.relativeDeadline) {
      firstMiss = { taskId: task.id, releaseTime: job.release, completionTime: t + 1 };
    }
  }
  return { maxResponseTimes: Object.fromEntries(maxResponse), firstMiss };
}

const configs: Readonly<Record<string, TaskSetConfig>> = {
  /** 题目场景修正版：恰好 77ms 截止期限，含同任务实例积压。 */
  spec: {
    tasks: [
      { id: "high", priority: 0, worstCaseExecutionTime: 50000, period: 100000, relativeDeadline: 100000 },
      { id: "low", priority: 1, worstCaseExecutionTime: 26000, period: 75000, relativeDeadline: 77000 },
    ],
  },
  /** 负载恰好 85%。 */
  exactLimit: {
    tasks: [
      { id: "a", priority: 0, worstCaseExecutionTime: 1, period: 2, relativeDeadline: 2 },
      { id: "b", priority: 1, worstCaseExecutionTime: 7, period: 20, relativeDeadline: 20 },
    ],
  },
  /** 截止期限大于周期，稳态下存在多实例积压。 */
  backlog: {
    tasks: [
      { id: "a", priority: 0, worstCaseExecutionTime: 2, period: 6, relativeDeadline: 6 },
      { id: "b", priority: 1, worstCaseExecutionTime: 4, period: 12, relativeDeadline: 30 },
      { id: "c", priority: 2, worstCaseExecutionTime: 1, period: 8, relativeDeadline: 25 },
    ],
  },
  /** 三任务，低优先级任务恰好在截止时刻完成。 */
  exactDeadline: {
    tasks: [
      { id: "a", priority: 0, worstCaseExecutionTime: 3, period: 10, relativeDeadline: 10 },
      { id: "b", priority: 1, worstCaseExecutionTime: 2, period: 12, relativeDeadline: 12 },
      { id: "c", priority: 2, worstCaseExecutionTime: 5, period: 30, relativeDeadline: 15 },
    ],
  },
  /** 负载合格但低优先级任务超时。 */
  missing: {
    tasks: [
      { id: "a", priority: 0, worstCaseExecutionTime: 4, period: 10, relativeDeadline: 10 },
      { id: "b", priority: 1, worstCaseExecutionTime: 5, period: 12, relativeDeadline: 8 },
    ],
  },
};

for (const [name, config] of Object.entries(configs)) {
  test(`与覆盖完整超周期的独立模拟一致：${name}`, () => {
    const result = analyzeConfig(config);
    const reference = referenceSimulate(config.tasks, 4);
    if (reference.firstMiss === null) {
      assert.equal(result.verdict, "accepted");
      if (result.verdict !== "accepted") return;
      assert.deepEqual(result.maxResponseTimes, reference.maxResponseTimes);
    } else {
      assert.equal(result.verdict, "rejected-deadline");
      if (result.verdict !== "rejected-deadline") return;
      assert.equal(result.miss.taskId, reference.firstMiss.taskId);
      assert.equal(result.miss.releaseTime, reference.firstMiss.releaseTime);
      assert.equal(result.miss.completionTime, reference.firstMiss.completionTime);
    }
  });
}
