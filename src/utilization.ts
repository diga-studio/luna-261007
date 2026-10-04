import type { Rational, TaskSetConfig } from "./types.js";
import { addRationals, compareRationals, makeRational } from "./rational.js";

/** 准入允许的负载上限：85/100。恰好等于上限时允许继续检查。 */
export const UTILIZATION_LIMIT: Rational = { numerator: 85n, denominator: 100n };

/** 精确计算 CPU 总负载：各任务 最坏执行耗时/周期 之和。 */
export function computeUtilization(config: TaskSetConfig): Rational {
  let total: Rational = { numerator: 0n, denominator: 1n };
  for (const task of config.tasks) {
    total = addRationals(
      total,
      makeRational(BigInt(task.worstCaseExecutionTime), BigInt(task.period)),
    );
  }
  return total;
}

/** 判断负载是否超过上限（恰好等于不算超过）。 */
export function exceedsUtilizationLimit(utilization: Rational): boolean {
  return compareRationals(utilization, UTILIZATION_LIMIT) > 0;
}
