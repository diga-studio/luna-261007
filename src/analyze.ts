import { analyzeResponseTimes } from "./responseTime.js";
import type { AdmissionVerdict, TaskSetConfig } from "./types.js";
import { checkUtilization } from "./utilization.js";

function validateConfig(config: TaskSetConfig): void {
  const ids = new Set<string>();
  const priorities = new Set<number>();
  for (const task of config.tasks) {
    if (ids.has(task.id)) {
      throw new Error(`任务标识重复: ${task.id}`);
    }
    ids.add(task.id);
    if (priorities.has(task.priority)) {
      throw new Error(`优先级重复: ${task.priority}`);
    }
    priorities.add(task.priority);
    for (const [name, value] of [
      ["worstCaseExecutionTime", task.worstCaseExecutionTime],
      ["period", task.period],
      ["relativeDeadline", task.relativeDeadline],
    ] as const) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`任务 ${task.id} 的 ${name} 必须是正整数微秒，实际为 ${value}`);
      }
    }
  }
}

/**
 * 准入分析主入口：
 * 1. 总负载超过 85% → 直接拒绝（仅说明负载原因）；恰好 85% 继续检查。
 * 2. 负载合格 → 对每个任务做忙期响应时间分析；任何任务存在超时实例即拒绝，
 *    并给出一个真实超时实例；全部按时完成则通过并报告各任务最大响应时间。
 */
export function analyzeConfig(config: TaskSetConfig): AdmissionVerdict {
  validateConfig(config);

  const utilization = checkUtilization(config);
  const utilizationFields = {
    utilizationNumerator: utilization.numerator,
    utilizationDenominator: utilization.denominator,
  } as const;

  if (!utilization.withinLimit) {
    return { kind: "rejected-utilization", ...utilizationFields };
  }

  const tasksByPriority = [...config.tasks].sort((a, b) => a.priority - b.priority);
  const analyses = analyzeResponseTimes(tasksByPriority);

  for (const analysis of analyses) {
    if (analysis.firstMiss !== undefined) {
      return {
        kind: "rejected-deadline",
        ...utilizationFields,
        miss: { taskId: analysis.taskId, ...analysis.firstMiss },
      };
    }
  }

  return {
    kind: "accepted",
    ...utilizationFields,
    maxResponseTimes: analyses.map((a) => ({
      taskId: a.taskId,
      maxResponseTime: a.maxResponseTime,
    })),
  };
}
