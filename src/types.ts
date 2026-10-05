/** 履约频率 */
export type Frequency = 'once' | 'monthly' | 'quarterly' | 'yearly';

/** 登记履约规则的入参；日期均为 UTC 自然日，格式 YYYY-MM-DD */
export interface RuleInput {
  contractId: string;
  firstDueDate: string;
  endDate: string;
  frequency: Frequency;
}

/** 某一期的处理结果状态 */
export type ResultStatus = 'completed' | 'exempted';

/** 单个合同在指定区间内的履约汇总 */
export interface ContractSummary {
  contractId: string;
  /** 分子：区间内按时完成的期次数 */
  numerator: number;
  /** 分母：区间内应到期期次扣除免除期次 */
  denominator: number;
  /** 分子/分母*100，四舍五入保留两位小数；分母为 0 时记 100 */
  score: number;
  /** 按未舍入比例判断是否低于 70 分 */
  atRisk: boolean;
}
