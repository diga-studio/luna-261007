import { Store } from "./store.js";
import type { FeedbackStatus, Instruction, MonotonicMs, PlanProgress } from "./types.js";
/** 同一指令两次领取的最小间隔。 */
export declare const RECLAIM_INTERVAL_MS = 30000;
/** 首次失败后的冷却时长。 */
export declare const FAILURE_COOLDOWN_MS: number;
/** 每个端点的最大有效尝试次数（初始尝试 + 3 次重试）。 */
export declare const MAX_ATTEMPTS_PER_ENDPOINT = 4;
export interface CreatePlanInput {
    patchId: string;
    endpointIds: string[];
    now: MonotonicMs;
}
/** 滚动补丁发布库，由上层调度器调用。 */
export declare class RolloutScheduler {
    protected store: Store;
    constructor(dbPath: string);
    close(): void;
    createPlan(_input: CreatePlanInput): string;
    claimInstructions(_now: MonotonicMs): Instruction[];
    reportFeedback(_attemptId: string, _status: FeedbackStatus, _now: MonotonicMs): void;
    getProgress(): PlanProgress;
}
