/**
 * 一批连续付款申请的扣留款分摊输入。
 * amounts[itemIndex][periodIndex] 为该分项在该期期末的
 * 累计已完工程与在场材料合计金额（整数分）。
 * 保证：每个分项的累计金额随期次不减少。
 */
export interface RetentionBatchInput {
  /** amounts[item][period]，整数分，逐项不减少 */
  readonly amounts: readonly (readonly number[])[];
}

/**
 * 分摊结果。cumulative[item][period] 为累计扣留款（分），
 * current[item][period] 为本期新增扣留款（分）。
 */
export interface RetentionBatchResult {
  readonly cumulative: readonly (readonly number[])[];
  readonly current: readonly (readonly number[])[];
}
