/** 隧道角色：主用优先于备用 */
export enum TunnelRole {
  Primary = "primary",
  Backup = "backup",
}

/** 上层探测结果：一次成功或一次超时 */
export enum ProbeOutcome {
  Success = "success",
  Timeout = "timeout",
}

/** 不透明会话句柄，由调用方的准备回调返回 */
export type SessionHandle = unknown;

/** 调用方提供的会话生命周期回调（进程内，无真实VPN通信） */
export interface SessionCallbacks {
  /**
   * 为指定组的指定隧道准备会话。异步返回唯一的不透明会话；
   * 可能立即成功、任意延后或永久不完成；不考虑失败。
   */
  prepare(groupId: string, tunnel: TunnelRole): Promise<SessionHandle>;
  /** 释放会话。同步完成且不会失败。 */
  release(groupId: string, tunnel: TunnelRole, session: SessionHandle): void;
}

/** 单组查询快照：目标与活动会话可能暂时不同，需同时展示 */
export interface GroupStatus {
  groupId: string;
  /** 主用隧道当前是否可用 */
  primaryUp: boolean;
  /** 备用隧道当前是否可用 */
  backupUp: boolean;
  /** 当前目标隧道（可用隧道中优先级最高者），都不可用时为 null */
  target: TunnelRole | null;
  /** 当前活动会话所属隧道，无活动会话时为 null */
  activeTunnel: TunnelRole | null;
  /** 当前活动会话句柄，无活动会话时为 null */
  activeSession: SessionHandle | null;
  /** 是否存在尚未完成的有效准备 */
  preparePending: boolean;
}

/** 库对外接口 */
export interface FailoverManager {
  /**
   * 接收一轮探测结果。results 已按组内隧道顺序（先主后备）排列并去重，
   * 长度恒为 2。同步完成全部状态变化与资源释放。
   */
  applyProbeResults(groupId: string, results: readonly ProbeOutcome[]): void;
  /** 查询单组状态 */
  getGroupStatus(groupId: string): GroupStatus;
  /** 查询全部组状态 */
  getAllGroupStatus(): GroupStatus[];
}
