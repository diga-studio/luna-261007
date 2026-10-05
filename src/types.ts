/** 工人技能证书：skill 为技能标识，certExpiresAt 为证书到期时刻（毫秒时间戳）。 */
export interface SkillCert {
  skill: string;
  certExpiresAt: number;
}

/** 名册中的一名工人。 */
export interface Worker {
  /** 唯一整数编号。 */
  id: number;
  /** 技能及对应证书到期时刻。 */
  skills: SkillCert[];
  /** 是否可任领班。 */
  leaderCapable: boolean;
  /** 当天已排工作分钟数（非负整数）。 */
  workedMinutes: number;
  /** 信用分，0 至 100 的整数。 */
  creditScore: number;
  /** 出勤半径（单程里程上限，非负数）。 */
  maxOneWayMiles: number;
  /** 避配客户列表。 */
  avoidedCustomers: string[];
}

/** 工单。 */
export interface WorkOrder {
  /** 客户标识。 */
  customer: string;
  /** 开始时刻（毫秒时间戳）。 */
  startAt: number;
  /** 结束时刻（毫秒时间戳），不跨日。 */
  endAt: number;
  /** 预计工作分钟数（非负整数）。 */
  workMinutes: number;
  /** 必需技能集合，1 至 16 项。 */
  requiredSkills: string[];
}

/** 上层调度系统为每位工人提供的、针对该工单的现场结论。 */
export interface WorkerOrderContext {
  workerId: number;
  /** 该时段是否可用（上层已完成排期冲突检查）。 */
  available: boolean;
  /** 到现场的单程里程。 */
  oneWayMiles: number;
  /** 往返行程分钟数（非负整数）。 */
  roundTripMinutes: number;
}

/** 推荐成功结果。 */
export interface CrewRecommendation {
  ok: true;
  /** 成员编号，按数值升序。 */
  members: number[];
  /** 领班编号（成员中编号最小的可任领班者）。 */
  leader: number;
  /** 班组总代价。 */
  totalCost: number;
}

/** 无解结果。 */
export interface NoCrew {
  ok: false;
  reason: "no-feasible-crew";
}

export type RecommendResult = CrewRecommendation | NoCrew;
