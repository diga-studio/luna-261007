/** 单调递增的 UTC 时间戳（毫秒），由调用方提供。 */
export type MonotonicMs = number;
/** 尝试的非终态：未反馈（已派发）、下载中、安装中。 */
export type AttemptProgress = "dispatched" | "downloading" | "installing";
/** 尝试的终态。 */
export type AttemptTerminal = "succeeded" | "failed" | "rolled_back";
export type AttemptState = AttemptProgress | AttemptTerminal;
/** 反馈可携带的状态（不含 dispatched，dispatched 由领取产生）。 */
export type FeedbackStatus = "downloading" | "installing" | AttemptTerminal;
export interface Instruction {
    /** 稳定且不复用的尝试标识。 */
    attemptId: string;
    planId: string;
    endpointId: string;
    patchId: string;
    /** 该端点的第几次尝试（从 1 开始）。 */
    attemptNo: number;
}
export interface EndpointProgress {
    endpointId: string;
    /** 已接受的有效尝试次数。 */
    attempts: number;
    /** 当前在途尝试标识，无则为 null。 */
    activeAttemptId: string | null;
    /** 端点是否已在本计划中结束（成功/已回滚/第4次失败）。 */
    finished: boolean;
    lastTerminal: AttemptTerminal | null;
}
export interface PlanProgress {
    planId: string;
    patchId: string;
    status: "active" | "completed";
    totalTargets: number;
    inFlightCap: number;
    inFlight: number;
    pending: number;
    succeeded: number;
    failed: number;
    rolledBack: number;
    endpoints: EndpointProgress[];
}
