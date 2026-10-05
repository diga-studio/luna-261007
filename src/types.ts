/** 岗位中的一项技能要求。技能之间互不重复。 */
export interface SkillRequirement {
  /** 已统一命名的技能标识，精确匹配。 */
  skill: string;
  /** 该技能所需的目标经验月数（正整数）。 */
  targetMonths: number;
  /** 该技能在岗位中的权重（正数）。 */
  weight: number;
}

/** 岗位：一组互不重复的技能要求。 */
export interface Job {
  requirements: SkillRequirement[];
}

/** 一条履历：起止月份（均计入）+ 该段履历覆盖的技能集合。 */
export interface ResumeEntry {
  /** 起始月份，格式 "YYYY-MM"。 */
  startMonth: string;
  /** 结束月份，格式 "YYYY-MM"，不早于 startMonth。 */
  endMonth: string;
  /** 该段履历涉及的技能名称集合。 */
  skills: string[];
}

/** 一个已分配月份的说明条目。 */
export interface MonthAllocation {
  /** 月份，格式 "YYYY-MM"。 */
  month: string;
  /** 该月分配给的岗位技能。 */
  skill: string;
  /** 该月贡献点数：最近 12 个月为 2，其余为 1。 */
  points: number;
  /** 该月加权得分 = points * 技能权重。 */
  weightedScore: number;
}

/** 单人评分结果。 */
export interface ScoreResult {
  /** 匹配分：100 * 分子 / 分母。 */
  score: number;
  /** 分子：所有已分配月份加权得分之和。 */
  numerator: number;
  /** 分母：各技能 目标月数*权重 之和的 2 倍。 */
  denominator: number;
  /** 月份分配说明，可逐项复核还原评分。 */
  allocations: MonthAllocation[];
}
