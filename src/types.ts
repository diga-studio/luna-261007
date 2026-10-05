/** 履约频率 */
export type Frequency = 'once' | 'monthly' | 'quarterly' | 'yearly';

/** 日期一律为 UTC 自然日，格式 YYYY-MM-DD */
export type UtcDate = string;

/** 登记履约规则的输入 */
export interface RuleInput {
  contractId: string;
  firstDueDate: UtcDate;
  endDate: UtcDate;
  frequency: Frequency;
}

/** 某一期的处理结果 */
export type PeriodOutcome =
  | { kind: 'completed'; completedDate: UtcDate }
  | { kind: 'waived' };

/** 单个合同的区间履约汇总 */
export interface ContractSummary {
  contractId: string;
  /** 按时完成期次数 */
  numerator: number;
  /** 应到期期次数（扣除免除） */
  denominator: number;
  /** 分数：分子/分母*100，四舍五入两位小数；分母为 0 记 100 */
  score: number;
  /** 是否低于 70 分（按未舍入比例判断） */
  atRisk: boolean;
}
