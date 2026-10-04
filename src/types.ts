/** 单个候选配置：某科室可选择的护士人数方案。 */
export interface CandidateOption {
  /** 护士人数（非负整数，同一科室内互异）。 */
  nurses: number;
  /** 该人数对应的贡献分（已折算模型权重的整数）。 */
  score: number;
  /** 相对当前配置的调整费用（整数分，当前人数必须为 0，其余非负）。 */
  cost: number;
}

/** 单个科室的输入。 */
export interface DepartmentInput {
  /** 科室标识，用于结果与解释中引用。 */
  id: string;
  /** 当前护士人数，必须出现在候选人数中且对应费用为 0。 */
  currentNurses: number;
  /** 可选候选人数集合（有限、人数互异）。 */
  candidates: CandidateOption[];
  /** 锁定科室必须保持当前人数。 */
  locked?: boolean;
}

/** 一次调配计算的完整输入（仅涉及一个班次）。 */
export interface AllocationRequest {
  departments: DepartmentInput[];
  /** 目标总分（整数），总分达到或超过即达标。 */
  targetScore: number;
}

/** 某个科室的最终选择。 */
export interface DepartmentChoice {
  id: string;
  fromNurses: number;
  toNurses: number;
  /** 贡献分变化（新分 - 旧分），可为 0 或正。 */
  scoreDelta: number;
  /** 该科室的调整费用。 */
  cost: number;
}

/** 达标建议。 */
export interface AllocationPlan {
  feasible: true;
  /** 各科室最终选择（仅列出人数发生变化的科室）。 */
  changes: DepartmentChoice[];
  /** 达标后的总分。 */
  totalScore: number;
  /** 总调整费用（最低费用的组合）。 */
  totalCost: number;
  /** 人数发生变化的科室数量（费用相同时最少）。 */
  changedDepartments: number;
  /** 人类可读的收益解释，与最终组合一致。 */
  explanation: string;
}

/** 不可达结果。 */
export interface InfeasibleResult {
  feasible: false;
  reason: string;
}

export type AllocationResult = AllocationPlan | InfeasibleResult;
