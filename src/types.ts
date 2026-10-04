/** 赛道标识与成员标识均为字符串。 */
export type TrackId = string;
export type MemberId = string;

/** 报名标识（等于全局创建序号，从 1 开始严格递增）。 */
export type RegistrationId = number;

export interface TrackSpec {
  id: TrackId;
  capacity: number;
}

export type RegistrationStatus = "waiting" | "admitted" | "withdrawn";

export interface RegistrationView {
  id: RegistrationId;
  seq: number;
  trackId: TrackId;
  memberIds: readonly MemberId[];
  status: RegistrationStatus;
}

export interface TrackView {
  id: TrackId;
  capacity: number;
  occupied: number;
}

export interface Inspection {
  registrations: RegistrationView[];
  tracks: TrackView[];
}

/** 诊断计数器：用于证明递补过程没有扫描无关候补。 */
export interface EngineStats {
  /** 因触发条件而重新检查候补可录取性的次数。 */
  rechecks: number;
  /** 在赛道容量窗口 / 成员阻塞索引中被访问的候补条目数。 */
  indexedEntriesVisited: number;
}
