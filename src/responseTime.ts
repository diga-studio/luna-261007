import type { TaskConfig } from "./types.js";

export interface TaskAnalysis {
  readonly taskId: string;
  /** 该任务所有实例中 完成时刻-释放时刻 的最大值（微秒） */
  readonly maxResponseTime: number;
  /** 首个超时实例（若有）：释放时刻、完成时刻、绝对截止时刻 */
  readonly firstMiss:
    | { readonly releaseTime: number; readonly completionTime: number; readonly deadline: number }
    | undefined;
}

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

function toSafeNumber(value: bigint, what: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${what} 超出可精确表示的数值范围: ${value}`);
  }
  return Number(value);
}

/**
 * 对按优先级升序（数字小在前）排列的任务集合做忙期（level-i busy period）
 * 响应时间分析。
 *
 * 模型：所有任务时刻 0 同步首次释放、严格周期释放、固定优先级完全抢占、
 * 无阻塞/抖动/调度开销。同步释放即临界时刻，因此第一个 level-i 忙期内的
 * 实例响应时间即无限运行中的最大值；忙期在总负载 < 1 时必然结束
 * （调用前须已通过负载检查）。
 *
 * 对任务 i 的第 q 个实例（q 从 0 起）：
 *   w(q) = (q+1)*C_i + Σ_{j 优先级高于 i} ⌈w(q)/T_j⌉ * C_j   （迭代至不动点）
 *   R(q) = w(q) - q*T_i
 * 当 w(q) ≤ (q+1)*T_i 时忙期结束。
 */
export function analyzeResponseTimes(
  tasksByPriority: readonly TaskConfig[],
): readonly TaskAnalysis[] {
  return tasksByPriority.map((task, index) => {
    const higher = tasksByPriority.slice(0, index);
    const C = BigInt(task.worstCaseExecutionTime);
    const T = BigInt(task.period);
    const D = BigInt(task.relativeDeadline);

    let maxResponse = 0n;
    let firstMiss:
      | { releaseTime: bigint; completionTime: bigint; deadline: bigint }
      | undefined;

    for (let q = 0n; ; q++) {
      const instanceCount = q + 1n;
      let w = instanceCount * C;
      for (;;) {
        let next = instanceCount * C;
        for (const hp of higher) {
          next +=
            ceilDiv(w, BigInt(hp.period)) * BigInt(hp.worstCaseExecutionTime);
        }
        if (next === w) break;
        w = next;
      }

      const release = q * T;
      const response = w - release;
      if (response > maxResponse) maxResponse = response;
      if (response > D && firstMiss === undefined) {
        firstMiss = { releaseTime: release, completionTime: w, deadline: release + D };
      }

      if (w <= instanceCount * T) break;
    }

    return {
      taskId: task.id,
      maxResponseTime: toSafeNumber(maxResponse, `任务 ${task.id} 的最大响应时间`),
      firstMiss:
        firstMiss === undefined
          ? undefined
          : {
              releaseTime: toSafeNumber(firstMiss.releaseTime, "释放时刻"),
              completionTime: toSafeNumber(firstMiss.completionTime, "完成时刻"),
              deadline: toSafeNumber(firstMiss.deadline, "截止时刻"),
            },
    };
  });
}
