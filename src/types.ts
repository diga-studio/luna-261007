/** 商品变体标识：SKU + 尺码 + 颜色等已展开到不可再分的粒度。 */
export type VariantId = string;

/** 单个变体的需求件数（正整数）。 */
export interface DemandLine {
  readonly variantId: VariantId;
  readonly quantity: number;
}

/** 一个已获批准、待拣货的礼包订单（已展开为实际变体需求）。 */
export interface CandidateOrder {
  /** 唯一提交序号，越小越早。 */
  readonly submissionSeq: number;
  readonly lines: readonly DemandLine[];
}

/** 固定库存快照：变体 -> 可用件数。规划期间不变。 */
export type InventorySnapshot = Readonly<Record<VariantId, number>>;

/** 规划结果：整单入选的订单集合。 */
export interface PickPlan {
  /** 入选订单，按提交序号升序。 */
  readonly selectedOrders: readonly CandidateOrder[];
}
