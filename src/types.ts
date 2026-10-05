/** 毫秒为单位的单调递增 UTC 时间戳，由调用方提供。 */
export type MonotonicMs = number;

/** 尝试的非终态进度与终态。 */
export type AttemptProgress = 'claimed' | 'downloading' | 'installing';
export type AttemptTerminal = 'succeeded' | 'failed' | 'rolled_back';
export type AttemptStatus = AttemptProgress | AttemptTerminal;

/** 端点在计划内的发布状态。 */
export type EndpointState =
  | 'pending'      // 尚未派发过尝试
  | 'in_flight'    // 当前有在途尝试
  | 'cooldown'     // 失败后冷却中，不占用名额
  | 'succeeded'    // 终态：成功
  | 'rolled_back'  // 终态：已回滚
  | 'failed';      // 终态：第 4 次失败

export interface Instruction {
  attemptId: string;
  planId: string;
  endpointId: string;
  patchId: string;
  attemptNo: number;
  /** true 表示这是对同一尝试的重投（30 秒去重窗口过后），标识与次数均不变。 */
  redispatch: boolean;
}

export type FeedbackStatus = 'downloading' | 'installing' | AttemptTerminal;

export interface FeedbackResult {
  accepted: boolean;
  /** 反馈被忽略的原因（重复终态、乱序回退、旧尝试迟到等）。 */
  ignoredReason?: string;
}

export interface EndpointProgress {
  endpointId: string;
  state: EndpointState;
  attemptCount: number;
  currentAttemptId: string | null;
  cooldownUntil: MonotonicMs | null;
}

export interface PlanProgress {
  planId: string;
  patchId: string;
  active: boolean;
  inflightCap: number;
  inflight: number;
  total: number;
  pending: number;
  cooldown: number;
  succeeded: number;
  rolledBack: number;
  failed: number;
  endpoints: EndpointProgress[];
}
