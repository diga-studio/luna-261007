/** 技能要求项：required ∈ [1,5]，weight ∈ [1,100] 整数。 */
export interface SkillRequirement {
  readonly skill: string;
  readonly required: number;
  readonly weight: number;
}

/** 关键岗位。 */
export interface Position {
  readonly id: string;
  readonly requirements: readonly SkillRequirement[];
}

/** 员工技能画像：actual ∈ [0,5] 整数，缺失技能按 0 处理。 */
export interface Employee {
  readonly id: string;
  readonly skills: Readonly<Record<string, number>>;
}

/** 就绪级别：0=现在，1=一年内，2=两年及以后。 */
export type ReadinessLevel = 0 | 1 | 2;

/** 岗位候选人名单中的一条岗位-候选人关系。 */
export interface CandidateEntry {
  readonly positionId: string;
  readonly employeeId: string;
  readonly readiness: ReadinessLevel;
}

/** planSuccession 的输入模型。 */
export interface SuccessionModel {
  readonly positions: readonly Position[];
  readonly employees: readonly Employee[];
  readonly candidates: readonly CandidateEntry[];
}

/** 一个预留配对。 */
export interface Reservation {
  readonly positionId: string;
  readonly employeeId: string;
  readonly readiness: ReadinessLevel;
  /** 万分数缺口，向下取整。 */
  readonly gap: number;
}

/** planSuccession 的输出。 */
export interface SuccessionPlan {
  readonly reservations: readonly Reservation[];
  /** 级别 0 的配对数。 */
  readonly c0: number;
  /** 级别 0 和 1 的配对数。 */
  readonly c1: number;
  /** 全部配对数。 */
  readonly c2: number;
  /** 已选配对的最大 gap；空方案为 0。 */
  readonly maxGap: number;
  /** 已选配对的 gap 总和；空方案为 0。 */
  readonly totalGap: number;
}
