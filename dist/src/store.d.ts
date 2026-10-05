import { DatabaseSync } from "node:sqlite";
import type { AttemptState, AttemptTerminal } from "./types.js";
export interface PlanRow {
    id: string;
    patch_id: string;
    status: "active" | "completed";
    created_at: number;
}
export interface TargetRow {
    plan_id: string;
    endpoint_id: string;
    /** 已接受的尝试次数。 */
    attempts: number;
    /** 冷却到期时刻（毫秒），无冷却为 null。 */
    cooldown_until: number | null;
    /** 端点是否已结束。 */
    finished: number;
    last_terminal: AttemptTerminal | null;
}
export interface AttemptRow {
    id: string;
    plan_id: string;
    endpoint_id: string;
    attempt_no: number;
    state: AttemptState;
    created_at: number;
    last_claim_at: number;
    /** 最先接受的终态反馈时刻，未终态为 null。 */
    finalized_at: number | null;
}
/** SQLite 持久化层。 */
export declare class Store {
    protected db: DatabaseSync;
    constructor(path: string);
    close(): void;
    getActivePlan(): PlanRow | undefined;
    getLatestPlan(): PlanRow | undefined;
    insertPlan(id: string, patchId: string, now: number): void;
    setPlanStatus(planId: string, status: "active" | "completed"): void;
    insertTarget(planId: string, endpointId: string): void;
    getTargets(planId: string): TargetRow[];
    getTarget(planId: string, endpointId: string): TargetRow | undefined;
    updateTarget(target: TargetRow): void;
    insertAttempt(attempt: AttemptRow): void;
    getAttempt(id: string): AttemptRow | undefined;
    updateAttemptState(id: string, state: AttemptState, finalizedAt: number | null): void;
    touchAttemptClaim(id: string, now: number): void;
    /** 某计划下所有在途（非终态）尝试。 */
    getInFlightAttempts(planId: string): AttemptRow[];
    getAttemptsForEndpoint(planId: string, endpointId: string): AttemptRow[];
    transaction<T>(fn: () => T): T;
}
