import type { TaskSetConfig } from "./types.js";

/** 负载上限：85%，恰好等于允许继续检查 */
export const UTILIZATION_LIMIT_NUMERATOR = 85n;
export const UTILIZATION_LIMIT_DENOMINATOR = 100n;

export interface UtilizationResult {
  /** 总负载的分子（已约分） */
  readonly numerator: bigint;
  /** 总负载的分母（已约分） */
  readonly denominator: bigint;
  /** 总负载是否不超过 85%（恰好等于视为合格） */
  readonly withinLimit: boolean;
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x === 0n ? 1n : x;
}

/**
 * 精确计算 CPU 总负载：各任务 最坏执行耗时/周期 之和。
 * 全程使用 BigInt 有理数运算，与 85% 上限的比较为精确比例判断，
 * 恰好等于 85% 时视为合格（withinLimit = true）。
 */
export function checkUtilization(config: TaskSetConfig): UtilizationResult {
  let numerator = 0n;
  let denominator = 1n;
  for (const task of config.tasks) {
    const c = BigInt(task.worstCaseExecutionTime);
    const t = BigInt(task.period);
    numerator = numerator * t + c * denominator;
    denominator = denominator * t;
    const common = gcd(numerator, denominator);
    numerator /= common;
    denominator /= common;
  }
  const withinLimit =
    numerator * UTILIZATION_LIMIT_DENOMINATOR <=
    UTILIZATION_LIMIT_NUMERATOR * denominator;
  return { numerator, denominator, withinLimit };
}
