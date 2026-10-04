/**
 * 任务配置与准入分析结果的公共类型定义。
 * 所有时间量均为正整数，单位为微秒。
 */

/** 单个周期任务的声明参数。 */
export interface TaskSpec {
  /** 任务唯一标识（由上层定义，如 "sampling"、"control"）。 */
  readonly id: string;
  /**
   * 固定优先级，数字越小越优先。
   * 同一份配置内各任务的优先级互不相同。
   */
  readonly priority: number;
  /** 最坏执行耗时（微秒，正整数）。 */
  readonly worstCaseExecutionTime: number;
  /** 释放周期（微秒，正整数）。 */
  readonly period: number;
  /** 相对截止期限（微秒，正整数），允许大于周期。 */
  readonly relativeDeadline: number;
}

/** 一份待准入的任务配置。 */
export interface TaskSetConfig {
  readonly tasks: readonly TaskSpec[];
}

/** 一个真实发生超时的实例，供工程师复核。 */
export interface DeadlineMiss {
  /** 超时实例所属任务的标识。 */
  readonly taskId: string;
  /** 实例释放时刻（微秒）。 */
  readonly releaseTime: number;
  /** 实例绝对截止时刻（微秒），等于释放时刻加相对截止期限。 */
  readonly absoluteDeadline: number;
  /** 实例实际完成时刻（微秒），严格大于绝对截止时刻。 */
  readonly completionTime: number;
}

/** 准入分析结论。 */
export type AdmissionResult =
  | {
      readonly verdict: "accepted";
      /** 精确计算的 CPU 总负载（有理数）。 */
      readonly utilization: Rational;
      /** 各任务在所有实例上的最大响应时间（微秒）。 */
      readonly maxResponseTimes: Readonly<Record<string, number>>;
    }
  | {
      readonly verdict: "rejected-utilization";
      readonly utilization: Rational;
      /** 人类可读的负载超限说明。 */
      readonly reason: string;
    }
  | {
      readonly verdict: "rejected-deadline";
      readonly utilization: Rational;
      /** 一个真实超时的实例。 */
      readonly miss: DeadlineMiss;
    };

/** 精确有理数，始终保持约分形式。 */
export interface Rational {
  readonly numerator: bigint;
  readonly denominator: bigint;
}
