import type {
  GroupStatus,
  ProbeResult,
  SessionCallbacks,
  SessionHandle,
  TunnelId,
} from './types.js';

const TIMEOUTS_TO_UNAVAILABLE = 3;

interface TunnelHealth {
  available: boolean;
  consecutiveTimeouts: number;
}

interface ActiveSession {
  tunnel: TunnelId;
  session: SessionHandle;
}

interface PendingPrepare {
  tunnel: TunnelId;
  token: number;
}

/**
 * 单组主备隧道切换状态机。
 * 只保存进程内状态；除调用方 prepare 回调的异步完成外，
 * 所有状态变化与资源释放在本组方法调用返回前同步完成。
 */
export class FailoverGroup {
  private readonly callbacks: SessionCallbacks;
  private readonly health: Record<TunnelId, TunnelHealth> = {
    primary: { available: false, consecutiveTimeouts: 0 },
    backup: { available: false, consecutiveTimeouts: 0 },
  };
  private active: ActiveSession | null = null;
  private pending: PendingPrepare | null = null;
  /** 上一次已据此采取行动（发起/作准备）的目标。 */
  private actedTarget: TunnelId | null = null;
  /** 当前唯一有效准备的令牌；0 表示没有在途有效准备。 */
  private validToken = 0;
  private prepareSeq = 0;

  constructor(
    readonly groupId: string,
    callbacks: SessionCallbacks,
  ) {
    this.callbacks = callbacks;
  }

  /** 应用一轮已按隧道排序、去重的探测结果。 */
  applyProbeResults(results: readonly ProbeResult[]): void {
    for (const result of results) {
      const health = this.health[result.tunnel];
      if (result.outcome === 'success') {
        health.available = true;
        health.consecutiveTimeouts = 0;
      } else {
        health.consecutiveTimeouts += 1;
        if (health.consecutiveTimeouts >= TIMEOUTS_TO_UNAVAILABLE) {
          health.available = false;
        }
      }
    }

    // 活动会话所属隧道失效：立即撤销其转发资格并释放。
    if (this.active !== null && !this.health[this.active.tunnel].available) {
      this.callbacks.release(this.active.session);
      this.active = null;
    }

    const target = this.computeTarget();
    if (target !== this.actedTarget) {
      this.actedTarget = target;
      this.invalidatePending();
      if (target !== null && this.active?.tunnel !== target) {
        this.startPrepare(target);
      }
    }
  }

  /** 当前目标隧道：可用隧道中优先级最高者（主优先），都不可用为 null。 */
  get target(): TunnelId | null {
    return this.computeTarget();
  }

  /** 当前对外可查询状态快照。 */
  status(): GroupStatus {
    return {
      groupId: this.groupId,
      primaryAvailable: this.health.primary.available,
      backupAvailable: this.health.backup.available,
      target: this.computeTarget(),
      activeTunnel: this.active?.tunnel ?? null,
      activeSession: this.active?.session ?? null,
      preparingTunnel: this.pending?.tunnel ?? null,
    };
  }

  private computeTarget(): TunnelId | null {
    if (this.health.primary.available) return 'primary';
    if (this.health.backup.available) return 'backup';
    return null;
  }

  private invalidatePending(): void {
    this.pending = null;
    this.validToken = 0;
  }

  private startPrepare(tunnel: TunnelId): void {
    const token = ++this.prepareSeq;
    this.pending = { tunnel, token };
    this.validToken = token;
    let prepared: PromiseLike<SessionHandle>;
    try {
      prepared = this.callbacks.prepare(this.groupId, tunnel);
    } catch {
      // 约定 prepare 不会失败；异常按永不完成处理，避免影响其他组。
      return;
    }
    Promise.resolve(prepared).then(
      (session) => this.onPrepared(token, tunnel, session),
      () => {
        // 约定 prepare 不会失败；拒绝同样按永不完成处理。
      },
    );
  }

  private onPrepared(token: number, tunnel: TunnelId, session: SessionHandle): void {
    if (token !== this.validToken || this.pending === null) {
      // 失效准备：所得会话只能释放，绝不获得转发权。
      this.callbacks.release(session);
      return;
    }
    if (this.active !== null) {
      // 被替换的活动会话恰好释放一次。
      this.callbacks.release(this.active.session);
    }
    this.active = { tunnel, session };
    this.pending = null;
    this.validToken = 0;
  }
}
