import { Store } from "./db.ts";
import type {
  CancelResult,
  EmployeeInit,
  HrAction,
  QuarterId,
  RedeemResult,
  RedemptionRecord,
  RedemptionServiceOptions,
  RedemptionStatus,
  RewardInit,
  Snapshot,
} from "./types.ts";

const TERMINAL: RedemptionStatus[] = ["COMPLETED", "REJECTED", "CANCELLED"];
const MAX_ATTEMPTS = 3;

function quarterOf(ms: number): QuarterId {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
}

/**
 * 奖励兑换结算服务。
 *
 * 并发模型：Node 单线程 + 同步 SQLite 写，所有资源扣减/归还都在同步临界区内完成，
 * 异步边界只存在于 HR 动作与重试定时器，因此任意交错下都不会出现部分扣减或重复释放。
 */
export class RedemptionService {
  private store: Store;
  private hrAction: HrAction;
  private retryDelays: [number, number];
  private now: () => number;
  private timers = new Map<string, TimerHandle[]>();

  constructor(dbPath: string, hrAction: HrAction, options?: RedemptionServiceOptions) {
    this.store = new Store(dbPath);
    this.hrAction = hrAction;
    this.retryDelays = options?.retryDelaysMs ?? [5000, 10000];
    this.now = options?.now ?? (() => Date.now());
  }

  seed(employees: EmployeeInit[], rewards: RewardInit[]): void {
    this.store.seed(employees, rewards);
  }

  /** 发起兑换。同 ID 幂等；资源不足则整笔拒绝，不留部分扣减。 */
  redeem(employeeId: string, rewardId: string, redemptionId: string): RedeemResult {
    const now = this.now();
    const outcome = this.store.tryAccept(
      redemptionId,
      employeeId,
      rewardId,
      quarterOf(now),
      now,
    );
    switch (outcome.kind) {
      case "duplicate":
        return { redemption: outcome.record, accepted: true, deduplicated: true };
      case "rejected":
        return { redemption: null, accepted: false, reason: outcome.reason };
      case "accepted":
        this.scheduleAttempts(redemptionId);
        return { redemption: outcome.record, accepted: true };
    }
  }

  /**
   * 申请取消。立即返回当前状态；取消的终结是异步的：
   * 仍有已启动尝试未返回时保持 CANCELLING 并继续占用资源。
   */
  cancel(redemptionId: string): CancelResult {
    const rec = this.store.getRedemption(redemptionId);
    if (!rec) throw new Error(`unknown redemption: ${redemptionId}`);
    if (TERMINAL.includes(rec.status) || rec.cancelRequested) {
      return { redemption: rec }; // 幂等：重复取消不重复释放
    }
    this.clearTimers(redemptionId); // 停止尚未启动的尝试
    const updated = this.store.markCancelRequested(redemptionId);
    if (updated.attemptsPending === 0) {
      // 尚无未决尝试，立即取消并归还资源
      this.store.settle(redemptionId, "CANCELLED", this.now());
    }
    return { redemption: this.store.getRedemption(redemptionId)! };
  }

  /** 一致快照：积分、库存、季度占额与兑换状态来自同一读事务。 */
  snapshot(): Snapshot {
    return this.store.snapshot(this.now());
  }

  close(): void {
    for (const id of [...this.timers.keys()]) this.clearTimers(id);
    this.store.close();
  }

  // ---- 内部：尝试调度与回执处理 ----

  private scheduleAttempts(id: string): void {
    this.maybeStartAttempt(id); // 受理后立即启动第一次尝试
    const handles = this.retryDelays.map((delay) => {
      const h = setTimeout(() => this.maybeStartAttempt(id), delay);
      h.unref();
      return h;
    });
    this.timers.set(id, handles);
  }

  /** 仅当兑换仍未定局且未申请取消、且次数未满时启动下一次尝试。 */
  private maybeStartAttempt(id: string): void {
    const rec = this.store.getRedemption(id);
    if (!rec || rec.status !== "PENDING" || rec.cancelRequested) return;
    if (rec.attemptsStarted >= MAX_ATTEMPTS) return;
    this.store.startAttempt(id);
    let promise: Promise<void>;
    try {
      promise = this.hrAction(id);
    } catch {
      promise = Promise.reject(new Error("hr action threw synchronously"));
    }
    promise.then(
      () => this.onAttemptSuccess(id),
      () => this.onAttemptFailure(id),
    );
  }

  private onAttemptSuccess(id: string): void {
    this.store.finishAttempt(id);
    // 任意已启动尝试的成功都使兑换完成；已终结则忽略迟到回执
    if (this.store.settle(id, "COMPLETED", this.now())) {
      this.clearTimers(id);
    }
  }

  private onAttemptFailure(id: string): void {
    this.store.finishAttempt(id);
    const rec = this.store.getRedemption(id);
    if (!rec || TERMINAL.includes(rec.status)) return;
    if (rec.attemptsPending > 0) return; // 仍有未决尝试，等待其回执
    if (rec.cancelRequested) {
      // 取消处理中且所有已启动尝试均失败 → 取消终结，归还资源
      if (this.store.settle(id, "CANCELLED", this.now())) this.clearTimers(id);
    } else if (rec.attemptsStarted >= MAX_ATTEMPTS) {
      // 三次均明确失败 → 拒绝兑换，归还资源
      if (this.store.settle(id, "REJECTED", this.now())) this.clearTimers(id);
    }
  }

  private clearTimers(id: string): void {
    const handles = this.timers.get(id);
    if (!handles) return;
    for (const h of handles) clearTimeout(h);
    this.timers.delete(id);
  }
}
