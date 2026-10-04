import type { DeadlineMiss, TaskSetConfig } from "./types.js";
import { compareRationals, makeRational } from "./rational.js";
import { computeUtilization } from "./utilization.js";

/** 调度模拟的输出。 */
export interface SimulationResult {
  /**
   * 各任务在所有已模拟实例上的最大响应时间（微秒）。
   * 当且仅当模拟覆盖了稳态下全部实例行为时，该值即真实最大值。
   */
  readonly maxResponseTimes: Readonly<Record<string, number>>;
  /** 模拟期间发现的第一个超时实例；没有则为 null。 */
  readonly firstMiss: DeadlineMiss | null;
}

interface PendingJob {
  readonly taskIndex: number;
  readonly releaseTime: bigint;
  remaining: bigint;
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a;
  let y = b;
  while (y !== 0n) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}

function lcm(a: bigint, b: bigint): bigint {
  return (a / gcd(a, b)) * b;
}

/**
 * 对配置做精确的事件驱动调度模拟：
 * 单核、固定优先级、完全抢占，所有任务在时刻 0 同时首次释放。
 * 模拟持续至调度状态在超周期边界上重复，从而覆盖无限持续运行中的所有实例。
 */
export function simulateSchedule(config: TaskSetConfig): SimulationResult {
  const tasks = config.tasks;
  if (tasks.length === 0) {
    return { maxResponseTimes: {}, firstMiss: null };
  }
  const utilization = computeUtilization(config);
  if (compareRationals(utilization, makeRational(1n, 1n)) >= 0) {
    throw new Error(
      "utilization is not below 100%; the schedule never reaches a steady state",
    );
  }

  const count = tasks.length;
  const exec = tasks.map((t) => BigInt(t.worstCaseExecutionTime));
  const period = tasks.map((t) => BigInt(t.period));
  const deadline = tasks.map((t) => BigInt(t.relativeDeadline));

  let hyperperiod = 1n;
  for (const p of period) {
    hyperperiod = lcm(hyperperiod, p);
  }

  const nextRelease = period.map((p) => 0n);
  const pending: PendingJob[] = [];
  const maxResponse = new Map<string, number>();
  const seenStates = new Map<string, bigint>();
  let firstMiss: DeadlineMiss | null = null;
  let now = 0n;
  let steadyStateReachedAt: bigint | null = null;

  const stateKey = (): string => {
    const byTask: string[][] = Array.from({ length: count }, () => []);
    for (const job of pending) {
      byTask[job.taskIndex].push(
        `${job.remaining.toString()}@${(now - job.releaseTime).toString()}`,
      );
    }
    return JSON.stringify(byTask);
  };

  const releaseDueJobs = (): void => {
    for (let i = 0; i < count; i += 1) {
      if (nextRelease[i] === now) {
        pending.push({ taskIndex: i, releaseTime: now, remaining: exec[i] });
        nextRelease[i] += period[i];
      }
    }
  };

  const checkSteadyState = (): void => {
    if (now === 0n || now % hyperperiod !== 0n || steadyStateReachedAt !== null) {
      return;
    }
    const key = stateKey();
    const seenAt = seenStates.get(key);
    if (seenAt !== undefined) {
      steadyStateReachedAt = now;
    } else {
      seenStates.set(key, now);
    }
  };

  const pickRunnable = (): number => {
    let best = -1;
    for (let i = 0; i < pending.length; i += 1) {
      if (
        best < 0 ||
        tasks[pending[i].taskIndex].priority < tasks[pending[best].taskIndex].priority
      ) {
        best = i;
      }
    }
    return best;
  };

  const nextReleaseTime = (): bigint => {
    let min = nextRelease[0];
    for (const t of nextRelease) {
      if (t < min) min = t;
    }
    return min;
  };

  const completeJob = (job: PendingJob): void => {
    const response = now - job.releaseTime;
    const task = tasks[job.taskIndex];
    const previous = maxResponse.get(task.id);
    const asNumber = Number(response);
    if (previous === undefined || asNumber > previous) {
      maxResponse.set(task.id, asNumber);
    }
    if (firstMiss === null && response > deadline[job.taskIndex]) {
      firstMiss = {
        taskId: task.id,
        releaseTime: Number(job.releaseTime),
        absoluteDeadline: Number(job.releaseTime + deadline[job.taskIndex]),
        completionTime: Number(now),
      };
    }
  };

  while (firstMiss === null) {
    releaseDueJobs();
    checkSteadyState();
    const steadyAt = steadyStateReachedAt;
    if (steadyAt !== null) {
      const hasPreSteadyJob = pending.some((job) => job.releaseTime < steadyAt);
      if (!hasPreSteadyJob) break;
    }
    const running = pickRunnable();
    if (running < 0) {
      now = nextReleaseTime();
      continue;
    }
    const job = pending[running];
    const nextEvent = nextReleaseTime();
    const finishAt = now + job.remaining;
    if (finishAt <= nextEvent) {
      now = finishAt;
      pending.splice(running, 1);
      completeJob(job);
    } else {
      job.remaining -= nextEvent - now;
      now = nextEvent;
    }
  }

  const maxResponseTimes: Record<string, number> = {};
  for (const [id, value] of maxResponse) {
    maxResponseTimes[id] = value;
  }
  return { maxResponseTimes, firstMiss };
}
