import type { DeadlineMiss, TaskSetConfig } from "./types.js";

export interface SimulationResult {
  /** 仿真覆盖的完整重复周期（各任务周期的最小公倍数，微秒） */
  readonly hyperperiod: number;
  /** 各任务在 [0, hyperperiod) 内释放实例的最大响应时间 */
  readonly maxResponseTimes: ReadonlyMap<string, number>;
  /** [0, hyperperiod) 内释放的首个超时实例（按完成时刻计，若有） */
  readonly firstMiss: DeadlineMiss | undefined;
}

interface Instance {
  readonly taskId: string;
  readonly priority: number;
  readonly releaseTime: number;
  readonly deadline: number;
  remaining: number;
}

function gcdBig(a: bigint, b: bigint): bigint {
  let x = a;
  let y = b;
  while (y !== 0n) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}

function toSafeNumber(value: bigint, what: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${what} 超出可精确表示的数值范围: ${value}`);
  }
  return Number(value);
}

/**
 * 独立的事件驱动仿真：从时刻 0 起精确重演固定优先级完全抢占调度，
 * 覆盖一个完整重复周期（超周期），并持续运行到该周期内释放的所有
 * 实例执行完毕。与分析算法互独立，用于交叉验证准入结论。
 *
 * 事件只发生在释放时刻与实例完成时刻；两次事件之间被运行实例不会被
 * 抢占，因此按事件推进即可得到精确结果。
 */
export function simulateHyperperiod(config: TaskSetConfig): SimulationResult {
  if (config.tasks.length === 0) {
    return { hyperperiod: 0, maxResponseTimes: new Map(), firstMiss: undefined };
  }

  let hyperperiodBig = 1n;
  for (const task of config.tasks) {
    hyperperiodBig =
      (hyperperiodBig / gcdBig(hyperperiodBig, BigInt(task.period))) *
      BigInt(task.period);
  }
  const hyperperiod = toSafeNumber(hyperperiodBig, "超周期");

  // 各任务在 [0, hyperperiod) 内的释放时刻
  const releases: { time: number; taskIndex: number }[] = [];
  config.tasks.forEach((task, taskIndex) => {
    for (let t = 0; t < hyperperiod; t += task.period) {
      releases.push({ time: t, taskIndex });
    }
  });
  releases.sort((a, b) => a.time - b.time);

  const ready: Instance[] = [];
  const maxResponse = new Map<string, number>();
  let firstMiss: DeadlineMiss | undefined;
  let currentTime = 0;
  let releaseCursor = 0;

  for (;;) {
    while (releaseCursor < releases.length && releases[releaseCursor].time <= currentTime) {
      const { taskIndex } = releases[releaseCursor];
      const task = config.tasks[taskIndex];
      ready.push({
        taskId: task.id,
        priority: task.priority,
        releaseTime: releases[releaseCursor].time,
        deadline: releases[releaseCursor].time + task.relativeDeadline,
        remaining: task.worstCaseExecutionTime,
      });
      releaseCursor++;
    }

    if (ready.length === 0) {
      if (releaseCursor >= releases.length) break;
      currentTime = releases[releaseCursor].time;
      continue;
    }

    // 选优先级最高（数字最小）的实例；同任务按释放顺序（先释放先入队）
    let runningIndex = 0;
    for (let i = 1; i < ready.length; i++) {
      if (ready[i].priority < ready[runningIndex].priority) runningIndex = i;
    }
    const running = ready[runningIndex];

    const nextReleaseTime =
      releaseCursor < releases.length ? releases[releaseCursor].time : Infinity;
    const finishTime = currentTime + running.remaining;

    if (finishTime <= nextReleaseTime) {
      // 实例完成（与下一释放同时完成也算先完成，完成时刻即截止判断时刻）
      currentTime = finishTime;
      ready.splice(runningIndex, 1);
      const response = currentTime - running.releaseTime;
      const prev = maxResponse.get(running.taskId);
      if (prev === undefined || response > prev) {
        maxResponse.set(running.taskId, response);
      }
      if (currentTime > running.deadline && firstMiss === undefined) {
        firstMiss = {
          taskId: running.taskId,
          releaseTime: running.releaseTime,
          completionTime: currentTime,
          deadline: running.deadline,
        };
      }
    } else {
      // 运行到下一次释放，被抢占后重新选择
      running.remaining -= nextReleaseTime - currentTime;
      currentTime = nextReleaseTime;
    }
  }

  return { hyperperiod, maxResponseTimes: maxResponse, firstMiss };
}
