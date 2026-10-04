import type { AdmissionResult, TaskSetConfig } from "./types.js";
import { formatRational } from "./rational.js";
import { simulateSchedule } from "./simulation.js";
import { computeUtilization, exceedsUtilizationLimit } from "./utilization.js";

function validateConfig(config: TaskSetConfig): void {
  const ids = new Set<string>();
  const priorities = new Set<number>();
  for (const task of config.tasks) {
    if (typeof task.id !== "string" || task.id.length === 0) {
      throw new Error("task id must be a non-empty string");
    }
    if (ids.has(task.id)) {
      throw new Error(`duplicate task id: ${task.id}`);
    }
    ids.add(task.id);
    if (!Number.isInteger(task.priority) || task.priority < 0) {
      throw new Error(`task ${task.id}: priority must be a non-negative integer`);
    }
    if (priorities.has(task.priority)) {
      throw new Error(`duplicate priority: ${task.priority}`);
    }
    priorities.add(task.priority);
    const fields = {
      worstCaseExecutionTime: task.worstCaseExecutionTime,
      period: task.period,
      relativeDeadline: task.relativeDeadline,
    };
    for (const [name, value] of Object.entries(fields)) {
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`task ${task.id}: ${name} must be a positive integer`);
      }
    }
  }
}

/**
 * 对候选配置做准入分析：
 * 1. 校验配置合法性（唯一标识、互不重复的优先级、正整数时间参数）；
 * 2. 精确计算 CPU 总负载，超过 85% 直接拒绝；
 * 3. 通过精确调度模拟检查所有实例的截止期限，给出可解释结论。
 */
export function analyzeConfig(config: TaskSetConfig): AdmissionResult {
  validateConfig(config);
  const utilization = computeUtilization(config);
  if (exceedsUtilizationLimit(utilization)) {
    return {
      verdict: "rejected-utilization",
      utilization,
      reason: `CPU 总负载 ${formatRational(utilization)} 超过上限 85/100`,
    };
  }
  const simulation = simulateSchedule(config);
  if (simulation.firstMiss !== null) {
    return {
      verdict: "rejected-deadline",
      utilization,
      miss: simulation.firstMiss,
    };
  }
  return {
    verdict: "accepted",
    utilization,
    maxResponseTimes: simulation.maxResponseTimes,
  };
}
