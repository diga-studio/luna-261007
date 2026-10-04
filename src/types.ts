/** 候选隧道标识：每组固定一主一备。 */
export type TunnelId = 'primary' | 'backup';

/** 一次探测结果：成功或超时。 */
export interface ProbeResult {
  readonly tunnel: TunnelId;
  readonly outcome: 'success' | 'timeout';
}

/** 不透明会话句柄，由调用方的准备回调返回，本库不解释其内容。 */
export type SessionHandle = unknown;

/**
 * 由调用方提供的进程内会话回调。
 * prepare 异步返回唯一会话，可能立即、任意延后或永不完成，不会失败；
 * release 同步完成且不会失败。
 */
export interface SessionCallbacks {
  prepare(groupId: string, tunnel: TunnelId): Promise<SessionHandle>;
  release(session: SessionHandle): void;
}

/** 单组对外可查询的运行状态。 */
export interface GroupStatus {
  readonly groupId: string;
  readonly primaryAvailable: boolean;
  readonly backupAvailable: boolean;
  /** 当前应转发到的目标隧道；两条都不可用时为 null。 */
  readonly target: TunnelId | null;
  /** 当前活动会话所属隧道；无活动会话时为 null。 */
  readonly activeTunnel: TunnelId | null;
  /** 当前活动会话句柄；无活动会话时为 null。 */
  readonly activeSession: SessionHandle | null;
  /** 正在准备中的隧道；无在途准备时为 null。 */
  readonly preparingTunnel: TunnelId | null;
}
