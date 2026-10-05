/**
 * 批次输入：periodsCents[p][i] 为第 p 期第 i 个分项的
 * 累计已完工程与在场材料合计金额（整数分）。
 * 分项顺序固定，期次按时间先后排列。
 */
export interface RetainageBatchInput {
  readonly periodsCents: ReadonlyArray<ReadonlyArray<number>>;
}

/** 单个分项在某一期的扣留款结果。 */
export interface ItemRetainage {
  /** 累计扣留款（分）。 */
  readonly cumulativeCents: number;
  /** 本期新增扣留款（分）。 */
  readonly currentCents: number;
}

/** 某一期所有分项的扣留款结果，顺序与输入分项一致。 */
export interface RetainagePeriodResult {
  readonly items: ReadonlyArray<ItemRetainage>;
}

/** 整批核算结果，期次顺序与输入一致。 */
export interface RetainageBatchResult {
  readonly periods: ReadonlyArray<RetainagePeriodResult>;
}
