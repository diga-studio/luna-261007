/** 成员标识：字符串或数字。 */
export type MemberId = string | number;

/** 报名状态。 */
export type RegistrationStatus = "waitlisted" | "admitted" | "withdrawn";

/** 引擎初始化配置。 */
export interface EngineConfig {
  /** 各赛道容量，下标即赛道 id（0..n-1），最多 64 条。 */
  capacities: readonly number[];
  /** 赛道间对称冲突关系，用赛道 id 对表示；同赛道恒与自身冲突，无需列出。 */
  conflicts?: ReadonlyArray<readonly [number, number]>;
}

/** inspect() 返回的单条报名快照。 */
export interface RegistrationSnapshot {
  /** 报名标识（与创建序号相同，严格递增）。 */
  id: number;
  /** 全局创建序号。 */
  seq: number;
  trackId: number;
  memberIds: readonly MemberId[];
  status: RegistrationStatus;
}

/** inspect() 返回的单条赛道快照。 */
export interface TrackSnapshot {
  trackId: number;
  capacity: number;
  /** 已录取报名占用的总人数。 */
  occupied: number;
}

/** inspect() 的整体返回。 */
export interface EngineSnapshot {
  registrations: readonly RegistrationSnapshot[];
  tracks: readonly TrackSnapshot[];
}

/** 诊断计数，用于规模测试证明未扫描无关候补。 */
export interface EngineDiagnostics {
  /** 因状态变化而被重新投入候选堆的候补条数累计。 */
  candidatesPushed: number;
  /** 从候选堆弹出并做精确可录取判定的条数累计。 */
  candidatesPopped: number;
  /** 成员占用状态变化触及的候补条数累计。 */
  memberBlockUpdates: number;
}
