import { Store } from "./store.js";
import { randomUUID } from "node:crypto";
/** 同一指令两次领取的最小间隔。 */
export const RECLAIM_INTERVAL_MS = 30_000;
/** 首次失败后的冷却时长。 */
export const FAILURE_COOLDOWN_MS = 15 * 60_000;
/** 每个端点的最大有效尝试次数（初始尝试 + 3 次重试）。 */
export const MAX_ATTEMPTS_PER_ENDPOINT = 4;
const PROGRESS_RANK = {
    dispatched: 0,
    downloading: 1,
    installing: 2,
};
/** 滚动补丁发布库，由上层调度器调用。 */
export class RolloutScheduler {
    store;
    constructor(dbPath) {
        this.store = new Store(dbPath);
    }
    close() {
        this.store.close();
    }
    createPlan(_input) {
        return this.store.transaction(() => {
            if (this.store.getActivePlan()) {
                throw new Error("an active plan already exists");
            }
            const endpointIds = [...new Set(_input.endpointIds)];
            if (endpointIds.length === 0) {
                throw new Error("a plan requires at least one target endpoint");
            }
            const planId = randomUUID();
            this.store.insertPlan(planId, _input.patchId, _input.now);
            for (const endpointId of endpointIds) {
                this.store.insertTarget(planId, endpointId);
            }
            return planId;
        });
    }
    claimInstructions(_now) {
        return this.store.transaction(() => {
            const plan = this.store.getActivePlan();
            if (!plan)
                return [];
            const targets = this.store.getTargets(plan.id);
            const cap = Math.max(1, Math.floor(targets.length / 10));
            const inFlight = this.store.getInFlightAttempts(plan.id);
            const instructions = [];
            // 重投：在途尝试满 30 秒可再次领取，标识与次数不变，名额不另计。
            for (const attempt of inFlight) {
                if (_now - attempt.last_claim_at >= RECLAIM_INTERVAL_MS) {
                    this.store.touchAttemptClaim(attempt.id, _now);
                    instructions.push({
                        attemptId: attempt.id,
                        planId: plan.id,
                        endpointId: attempt.endpoint_id,
                        patchId: plan.patch_id,
                        attemptNo: attempt.attempt_no,
                    });
                }
            }
            // 补满空闲名额：跳过在途与冷却中的端点，不被它们阻塞。
            const busyEndpoints = new Set(inFlight.map((a) => a.endpoint_id));
            let freeSlots = cap - inFlight.length;
            for (const target of targets) {
                if (freeSlots <= 0)
                    break;
                if (target.finished === 1 || busyEndpoints.has(target.endpoint_id)) {
                    continue;
                }
                if (target.cooldown_until !== null && target.cooldown_until > _now) {
                    continue;
                }
                const attemptNo = target.attempts + 1;
                const attemptId = randomUUID();
                this.store.insertAttempt({
                    id: attemptId,
                    plan_id: plan.id,
                    endpoint_id: target.endpoint_id,
                    attempt_no: attemptNo,
                    state: "dispatched",
                    created_at: _now,
                    last_claim_at: _now,
                    finalized_at: null,
                });
                target.attempts = attemptNo;
                target.cooldown_until = null;
                this.store.updateTarget(target);
                busyEndpoints.add(target.endpoint_id);
                freeSlots -= 1;
                instructions.push({
                    attemptId,
                    planId: plan.id,
                    endpointId: target.endpoint_id,
                    patchId: plan.patch_id,
                    attemptNo,
                });
            }
            return instructions;
        });
    }
    reportFeedback(_attemptId, _status, _now) {
        this.store.transaction(() => {
            const attempt = this.store.getAttempt(_attemptId);
            if (!attempt) {
                throw new Error(`unknown attempt: ${_attemptId}`);
            }
            // 终态由最先接受的反馈固定，其后反馈（含旧尝试的迟到反馈）不再改变。
            if (attempt.state in { succeeded: 1, failed: 1, rolled_back: 1 }) {
                return;
            }
            if (_status === "downloading" || _status === "installing") {
                // 进度只能前进，不能从安装中退回下载中；重复与乱序反馈忽略。
                if (PROGRESS_RANK[_status] > PROGRESS_RANK[attempt.state]) {
                    this.store.updateAttemptState(attempt.id, _status, null);
                }
                return;
            }
            // 接受终态反馈。
            this.store.updateAttemptState(attempt.id, _status, _now);
            const target = this.store.getTarget(attempt.plan_id, attempt.endpoint_id);
            if (!target)
                return;
            target.last_terminal = _status;
            if (_status === "failed") {
                if (target.attempts >= MAX_ATTEMPTS_PER_ENDPOINT) {
                    target.finished = 1;
                }
                else {
                    // 冷却从首次接受的失败反馈起算，期间不占名额。
                    target.cooldown_until = _now + FAILURE_COOLDOWN_MS;
                }
            }
            else {
                target.finished = 1;
            }
            this.store.updateTarget(target);
            // 全部端点结束后计划完成。
            const targets = this.store.getTargets(attempt.plan_id);
            if (targets.every((t) => t.finished === 1)) {
                this.store.setPlanStatus(attempt.plan_id, "completed");
            }
        });
    }
    getProgress() {
        const plan = this.store.getActivePlan() ?? this.store.getLatestPlan();
        if (!plan) {
            throw new Error("no plan exists");
        }
        const targets = this.store.getTargets(plan.id);
        const inFlight = this.store.getInFlightAttempts(plan.id);
        const activeByEndpoint = new Map(inFlight.map((a) => [a.endpoint_id, a.id]));
        return {
            planId: plan.id,
            patchId: plan.patch_id,
            status: plan.status,
            totalTargets: targets.length,
            inFlightCap: Math.max(1, Math.floor(targets.length / 10)),
            inFlight: inFlight.length,
            pending: targets.filter((t) => t.finished === 0 && !activeByEndpoint.has(t.endpoint_id)).length,
            succeeded: targets.filter((t) => t.last_terminal === "succeeded").length,
            failed: targets.filter((t) => t.finished === 1 && t.last_terminal === "failed").length,
            rolledBack: targets.filter((t) => t.last_terminal === "rolled_back")
                .length,
            endpoints: targets.map((t) => ({
                endpointId: t.endpoint_id,
                attempts: t.attempts,
                activeAttemptId: activeByEndpoint.get(t.endpoint_id) ?? null,
                finished: t.finished === 1,
                lastTerminal: t.last_terminal,
            })),
        };
    }
}
