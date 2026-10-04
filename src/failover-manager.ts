import {
  FailoverManager,
  GroupStatus,
  ProbeOutcome,
  SessionCallbacks,
  SessionHandle,
  TunnelRole,
} from "./types";

/** 单库实例最多管理的互联组数 */
export const MAX_GROUPS = 250;

/** 连续多少次超时判定隧道不可用 */
export const TIMEOUT_THRESHOLD = 3;

interface TunnelState {
  up: boolean;
  consecutiveTimeouts: number;
}

interface ActiveSession {
  tunnel: TunnelRole;
  session: SessionHandle;
}

/** 一次有效准备的令牌；目标改变时整组令牌被替换，旧令牌永久失效 */
interface PrepareToken {
  tunnel: TunnelRole;
}

interface GroupState {
  id: string;
  primary: TunnelState;
  backup: TunnelState;
  active: ActiveSession | null;
  pending: PrepareToken | null;
}

/**
 * 主备隧道切换管理器。配置与运行状态只保存在进程内；
 * 会话准备/释放通过调用方回调完成，不涉及真实 VPN 通信。
 */
export class VpnFailoverManager implements FailoverManager {
  private readonly callbacks: SessionCallbacks;
  private readonly groups = new Map<string, GroupState>();

  constructor(callbacks: SessionCallbacks, groupIds: readonly string[]) {
    if (groupIds.length > MAX_GROUPS) {
      throw new RangeError(`group count ${groupIds.length} exceeds ${MAX_GROUPS}`);
    }
    this.callbacks = callbacks;
    for (const id of groupIds) {
      if (this.groups.has(id)) {
        throw new Error(`duplicate group id: ${id}`);
      }
      this.groups.set(id, {
        id,
        primary: { up: false, consecutiveTimeouts: 0 },
        backup: { up: false, consecutiveTimeouts: 0 },
        active: null,
        pending: null,
      });
    }
  }

  applyProbeResults(groupId: string, results: readonly ProbeOutcome[]): void {
    const group = this.requireGroup(groupId);
    if (results.length !== 2) {
      throw new RangeError(`expected 2 probe results (primary, backup), got ${results.length}`);
    }
    this.applyOutcome(group.primary, results[0]);
    this.applyOutcome(group.backup, results[1]);
    this.reconcile(group);
  }

  getGroupStatus(groupId: string): GroupStatus {
    return this.snapshot(this.requireGroup(groupId));
  }

  getAllGroupStatus(): GroupStatus[] {
    const out: GroupStatus[] = [];
    for (const group of this.groups.values()) {
      out.push(this.snapshot(group));
    }
    return out;
  }

  private requireGroup(groupId: string): GroupState {
    const group = this.groups.get(groupId);
    if (!group) {
      throw new Error(`unknown group id: ${groupId}`);
    }
    return group;
  }

  private applyOutcome(tunnel: TunnelState, outcome: ProbeOutcome): void {
    if (outcome === ProbeOutcome.Success) {
      tunnel.up = true;
      tunnel.consecutiveTimeouts = 0;
    } else {
      tunnel.consecutiveTimeouts += 1;
      if (tunnel.consecutiveTimeouts >= TIMEOUT_THRESHOLD) {
        tunnel.up = false;
      }
    }
  }

  private tunnelState(group: GroupState, role: TunnelRole): TunnelState {
    return role === TunnelRole.Primary ? group.primary : group.backup;
  }

  private computeTarget(group: GroupState): TunnelRole | null {
    if (group.primary.up) return TunnelRole.Primary;
    if (group.backup.up) return TunnelRole.Backup;
    return null;
  }

  /**
   * 探测结果应用后的统一协调：撤销失效活动会话、
   * 作废过期准备、按需发起新准备。全部同步完成。
   */
  private reconcile(group: GroupState): void {
    if (group.active && !this.tunnelState(group, group.active.tunnel).up) {
      const revoked = group.active;
      group.active = null;
      this.callbacks.release(group.id, revoked.tunnel, revoked.session);
    }

    const target = this.computeTarget(group);

    if (group.pending && group.pending.tunnel !== target) {
      group.pending = null; // 旧准备永久失效，完成后只能释放
    }

    if (target === null) return;
    if (group.active && group.active.tunnel === target) return;
    if (group.pending) return;

    const token: PrepareToken = { tunnel: target };
    group.pending = token;
    this.callbacks.prepare(group.id, target).then(
      (session) => this.onPrepareComplete(group, token, session),
      () => {
        /* 不考虑准备失败；忽略拒绝以避免未处理异常 */
      },
    );
  }

  private onPrepareComplete(
    group: GroupState,
    token: PrepareToken,
    session: SessionHandle,
  ): void {
    if (group.pending !== token) {
      // 失效准备：所得会话只能释放
      this.callbacks.release(group.id, token.tunnel, session);
      return;
    }
    group.pending = null;
    const replaced = group.active;
    group.active = { tunnel: token.tunnel, session };
    if (replaced) {
      this.callbacks.release(group.id, replaced.tunnel, replaced.session);
    }
  }

  private snapshot(group: GroupState): GroupStatus {
    return {
      groupId: group.id,
      primaryUp: group.primary.up,
      backupUp: group.backup.up,
      target: this.computeTarget(group),
      activeTunnel: group.active ? group.active.tunnel : null,
      activeSession: group.active ? group.active.session : null,
      preparePending: group.pending !== null,
    };
  }
}
