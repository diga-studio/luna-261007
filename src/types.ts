/**
 * A stock-keeping unit variant. SKU, size or color differences make
 * distinct variants; stock is never interchangeable across variants.
 */
export type VariantId = string;

/** Immutable stock snapshot: available units per variant. */
export type StockSnapshot = Readonly<Record<VariantId, number>>;

/**
 * A single approved order ready for picking. Each order is one gift pack
 * for one recipient, already expanded into concrete variant demands.
 */
export interface CandidateOrder {
  /** Unique submission sequence number; smaller means submitted earlier. */
  readonly sequence: number;
  /** Required units per variant; every quantity is a positive integer. */
  readonly demands: Readonly<Record<VariantId, number>>;
}

/** Planning result: the set of orders selected for picking. */
export interface PickingPlan {
  /** Selected orders, sorted by ascending submission sequence. */
  readonly selectedOrders: readonly CandidateOrder[];
}
