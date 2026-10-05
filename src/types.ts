/** 工人的一项技能及其证书到期时刻（ epoch 毫秒）。 */
export interface SkillCertification {
  /** 技能名称，如 "电工"。 */
  skill: string;
  /** 证书到期时刻（epoch 毫秒）。到期时刻晚于或等于工单结束时刻时，该技能可用于覆盖要求。 */
  certExpiresAt: number;
}

/** 名册中的一名工人。 */
export interface Worker {
  /** 唯一整数编号。 */
  id: number;
  /** 技能及对应证书到期时刻，至多 20 项。 */
  skills: SkillCertification[];
  /** 是否可任领班。 */
  canLead: boolean;
  /** 当天已排工作分钟数（非负整数）。 */
  workedMinutes: number;
  /** 信用分，0 至 100 的整数。 */
  creditScore: number;
  /** 出勤半径（单程里程上限，英里）。 */
  oneWayRadiusMiles: number;
  /** 避配客户列表。 */
  avoidedClients: string[];
}

/** 一张工单。工单不跨日。 */
export interface WorkOrder {
  /** 客户标识。 */
  client: string;
  /** 开始时刻（epoch 毫秒）。 */
  startsAt: number;
  /** 结束时刻（epoch 毫秒）。 */
  endsAt: number;
  /** 预计工作分钟数（非负整数）。 */
  workMinutes: number;
  /** 必需技能集合，1 至 16 项。 */
  requiredSkills: string[];
}

/** 上层调度系统为某位工人在该工单时段提供的结论性信息。 */
export interface WorkerAssignmentContext {
  /** 该工人在工单时段是否可用（上层已完成排期冲突检查）。 */
  available: boolean;
  /** 到现场的单程里程（英里）。 */
  oneWayMiles: number;
  /** 往返行程分钟数（非负整数）。 */
  roundTripMinutes: number;
}

/** 推荐结果：一支合法且总代价最低的班组。 */
export interface CrewRecommendation {
  /** 成员编号，按数值升序排列。 */
  memberIds: number[];
  /** 领班编号：成员中编号最小的可任领班者。 */
  foremanId: number;
  /** 班组总代价：所有成员个人代价之和。 */
  totalCost: number;
}
