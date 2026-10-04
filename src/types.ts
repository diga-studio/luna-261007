/**
 * 一份待下发的任务配置：单核、固定优先级、完全抢占的周期任务集合。
 * 所有时间均为正整数微秒；优先级数字越小越优先。
 */
export interface TaskConfig {
  /** 任务唯一标识 */
  readonly id: string;
  /** 优先级，配置内互不重复，0 最高 */
  readonly priority: number;
  /** 最坏执行耗时（微秒） */
  readonly worstCaseExecutionTime: number;
  /** 释放周期（微秒） */
  readonly period: number;
  /** 相对截止期限（微秒），允许大于周期 */
  readonly relativeDeadline: number;
}

export interface TaskSetConfig {
  readonly tasks: readonly TaskConfig[];
}

/** 一个真实发生的超时实例，供工程师复核 */
export interface DeadlineMiss {
  readonly taskId: string;
  /** 实例释放时刻（微秒，自时刻 0 起） */
  readonly releaseTime: number;
  /** 实例完成时刻（微秒） */
  readonly completionTime: number;
  /** 实例绝对截止时刻 = 释放时刻 + 相对截止期限 */
  readonly deadline: number;
}

/** 通过时各任务的最大响应时间（完成时刻 - 释放时刻的最大值） */
export interface TaskResponseTime {
  readonly taskId: string;
  readonly maxResponseTime: number;
}

export type AdmissionVerdict =
  | {
      readonly kind: "rejected-utilization";
      /** 精确的总负载比值（已约分） */
      readonly utilizationNumerator: bigint;
      readonly utilizationDenominator: bigint;
    }
  | {
      readonly kind: "rejected-deadline";
      readonly utilizationNumerator: bigint;
      readonly utilizationDenominator: bigint;
      /** 至少一个真实超时实例 */
      readonly miss: DeadlineMiss;
    }
  | {
      readonly kind: "accepted";
      readonly utilizationNumerator: bigint;
      readonly utilizationDenominator: bigint;
      readonly maxResponseTimes: readonly TaskResponseTime[];
    };
