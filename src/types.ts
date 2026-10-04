/** 单个候选配置：某科室可选择的一个人数方案 */
export interface CandidateOption {
  /** 候选人数（同一科室内互异） */
  headcount: number;
  /** 该候选对应的贡献分（已折算模型权重的整数分） */
  score: number;
  /** 相对当前配置的调整费用（整数分，当前配置恒为 0，其余非负） */
  cost: number;
}

/** 一个科室的输入 */
export interface DepartmentInput {
  /** 科室标识，用于结果解释 */
  id: string;
  /** 当前人数，必须出现在 candidates 中且费用为 0 */
  currentHeadcount: number;
  /** 锁定科室必须保持当前人数 */
  locked?: boolean;
  /** 有限个候选人数方案 */
  candidates: CandidateOption[];
}

/** 单个科室的调整说明 */
export interface DepartmentChange {
  departmentId: string;
  fromHeadcount: number;
  toHeadcount: number;
  /** 贡献分变化（新分 - 旧分） */
  scoreGain: number;
  /** 该科室调整费用 */
  cost: number;
}

/** 调配建议结果 */
export interface StaffingAdvice {
  /** 是否存在满足人数守恒、锁定限制且达标的组合 */
  reachable: boolean;
  /** 目标分 */
  targetScore: number;
  /** 最终组合总分（不可达时为 0） */
  totalScore: number;
  /** 最终组合总调整费用（不可达时为 0） */
  totalCost: number;
  /** 人数发生变化的科室数量 */
  changedDepartments: number;
  /** 各改动科室的调整及收益说明 */
  changes: DepartmentChange[];
  /** 人类可读的结论摘要 */
  summary: string;
}
