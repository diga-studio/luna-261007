import type {
  AttemptProgress,
  AttemptTerminal,
  EndpointState,
  FeedbackResult,
  FeedbackStatus,
  Instruction,
  MonotonicMs,
  PlanProgress,
} from './types.js';
import { Store } from './store.js';
import type { AttemptRow, EndpointRow, PlanRow } from './store.js';

export interface CreatePlanInput {
  planId: string;
  patchId: string;
  endpointIds: string[];
}

/** 同一指令两次领取之间的去重窗口。 */
export const REDISPATCH_AFTER_MS = 30_000;
/** 首次失败反馈被接受后的冷却时长。 */
export const FAILURE_COOLDOWN_MS = 15 * 60_000;
/** 每个端点在一个计划内的最大有效尝试次数（初始 1 次 + 重试 3 次）。 */
export const MAX_ATTEMPTS = 4;

const INFLIGHT_STATUSES: AttemptProgress[] = ['claimed', 'downloading', 'installing'];
const TERMINAL_ENDPOINT_STATES: EndpointState[] = ['succeeded', 'rolled_back', 'failed'];
const PROGRESS_RANK: Record<AttemptProgress, number> = {
  claimed: 0,
  downloading: 1,
  installing: 2,
};

function isTerminalFeedback(status: FeedbackStatus): status is AttemptTerminal {
  return status === 'succeeded' || status === 'failed' || status === 'rolled_back';
}

function isInflightStatus(status: string): status is AttemptProgress {
  return (INFLIGHT_STATUSES as string[]).includes(status);
}

/**
 * 滚动补丁发布库，由上层调度器驱动。
 * 所有期限都按调用方提供的单调递增 UTC 毫秒时间计算，库内不读真实时钟。
 */
export class RollingRelease {
  private readonly store: Store;

  constructor(dbPath: string) {
    this.store = new Store(dbPath);
  }

  close(): void {
    this.store.close();
  }

  /**
   * 创建发布计划。同一时刻只允许一个活动计划。
   * 目标端点集合在创建时去重并固定，在途上限为目标数的 10% 向下取整、最少 1。
   */
  createPlan(input: CreatePlanInput): void {
    if (this.store.getActivePlan()) {
      throw new Error('an active plan already exists');
    }
    const endpointIds = [...new Set(input.endpointIds)];
    if (endpointIds.length === 0) {
      throw new Error('plan must target at least one endpoint');
    }
    const inflightCap = Math.max(1, Math.floor(endpointIds.length / 10));
    this.store.createPlan(input.planId, input.patchId, inflightCap, endpointIds);
  }

  /**
   * 领取安装指令。先重投超过 30 秒未被再次领取的在途指令（标识、次数、名额均不变），
   * 再用新尝试补满空闲名额；有可派发目标时不被其他端点的冷却或在途状态阻塞。
   */
  claim(now: MonotonicMs): Instruction[] {
    const plan = this.store.getActivePlan();
    if (!plan) return [];

    const instructions: Instruction[] = [];

    for (const attempt of this.store.listRedispatchable(plan.planId, now - REDISPATCH_AFTER_MS)) {
      this.store.touchAttemptClaim(attempt.attemptId, now);
      instructions.push(this.toInstruction(plan, attempt, true));
    }

    let freeSlots = plan.inflightCap - this.store.countInflight(plan.planId);
    if (freeSlots <= 0) return instructions;

    for (const endpoint of this.store.listEndpoints(plan.planId)) {
      if (freeSlots <= 0) break;
      if (!this.isDispatchable(endpoint, now)) continue;
      const attemptNo = endpoint.attemptCount + 1;
      const attempt: AttemptRow = {
        attemptId: `${plan.planId}:${endpoint.endpointId}:${attemptNo}`,
        planId: plan.planId,
        endpointId: endpoint.endpointId,
        attemptNo,
        status: 'claimed',
        lastClaimedAt: now,
        terminalAt: null,
      };
      this.store.insertAttempt(attempt);
      this.store.updateEndpointState(plan.planId, endpoint.endpointId, 'in_flight', {
        attemptCount: attemptNo,
        currentAttemptId: attempt.attemptId,
        cooldownUntil: null,
      });
      instructions.push(this.toInstruction(plan, attempt, false));
      freeSlots -= 1;
    }
    return instructions;
  }

  /**
   * 接收执行反馈。进度反馈单调推进、不可回退；最先接受的终态固定尝试结果，
   * 之后的重复或迟到反馈不再改变任何状态。
   */
  feedback(attemptId: string, status: FeedbackStatus, now: MonotonicMs): FeedbackResult {
    const attempt = this.store.getAttempt(attemptId);
    if (!attempt) throw new Error(`unknown attempt: ${attemptId}`);

    if (!isInflightStatus(attempt.status)) {
      return { accepted: false, ignoredReason: 'attempt already has a terminal result' };
    }

    if (!isTerminalFeedback(status)) {
      if (PROGRESS_RANK[status] <= PROGRESS_RANK[attempt.status]) {
        return { accepted: false, ignoredReason: 'progress did not advance' };
      }
      this.store.updateAttemptStatus(attemptId, status, null);
      return { accepted: true };
    }

    this.store.updateAttemptStatus(attemptId, status, now);

    const endpoint = this.store.getEndpoint(attempt.planId, attempt.endpointId);
    if (!endpoint || endpoint.currentAttemptId !== attemptId) {
      // 旧尝试的迟到终态：只固定该尝试自身的结果，不影响端点当前状态与名额。
      return { accepted: true };
    }

    if (status === 'failed') {
      if (attempt.attemptNo >= MAX_ATTEMPTS) {
        this.finishEndpoint(attempt.planId, endpoint, 'failed');
      } else {
        this.store.updateEndpointState(attempt.planId, endpoint.endpointId, 'cooldown', {
          currentAttemptId: null,
          cooldownUntil: now + FAILURE_COOLDOWN_MS,
        });
      }
    } else {
      this.finishEndpoint(attempt.planId, endpoint, status);
    }
    return { accepted: true };
  }

  /** 查看当前（或最近一次）计划的发布进度。 */
  progress(): PlanProgress {
    const plan = this.store.getActivePlan() ?? this.store.getLatestPlan();
    if (!plan) throw new Error('no plan exists');
    const endpoints = this.store.listEndpoints(plan.planId);
    const count = (state: EndpointState) => endpoints.filter((e) => e.state === state).length;
    return {
      planId: plan.planId,
      patchId: plan.patchId,
      active: plan.status === 'active',
      inflightCap: plan.inflightCap,
      inflight: this.store.countInflight(plan.planId),
      total: endpoints.length,
      pending: count('pending') + count('in_flight') + count('cooldown'),
      cooldown: count('cooldown'),
      succeeded: count('succeeded'),
      rolledBack: count('rolled_back'),
      failed: count('failed'),
      endpoints: endpoints.map((e) => ({
        endpointId: e.endpointId,
        state: e.state,
        attemptCount: e.attemptCount,
        currentAttemptId: e.currentAttemptId,
        cooldownUntil: e.cooldownUntil,
      })),
    };
  }

  private isDispatchable(endpoint: EndpointRow, now: MonotonicMs): boolean {
    if (endpoint.state === 'pending') return true;
    if (endpoint.state === 'cooldown') {
      return endpoint.cooldownUntil !== null && endpoint.cooldownUntil <= now;
    }
    return false;
  }

  private finishEndpoint(planId: string, endpoint: EndpointRow, state: EndpointState): void {
    this.store.updateEndpointState(planId, endpoint.endpointId, state, {
      currentAttemptId: null,
      cooldownUntil: null,
    });
    const remaining = this.store
      .listEndpoints(planId)
      .some((e) => !TERMINAL_ENDPOINT_STATES.includes(e.state));
    if (!remaining) this.store.markPlanDone(planId);
  }

  private toInstruction(plan: PlanRow, attempt: AttemptRow, redispatch: boolean): Instruction {
    return {
      attemptId: attempt.attemptId,
      planId: plan.planId,
      endpointId: attempt.endpointId,
      patchId: plan.patchId,
      attemptNo: attempt.attemptNo,
      redispatch,
    };
  }
}
