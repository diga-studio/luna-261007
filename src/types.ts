import type { Rational } from "./rational.js";

/** Decimal integer given as a string, number, or bigint. */
export type BigIntLike = string | number | bigint;

export interface PreferredClassInput {
  /** Unique class id. */
  id: string;
  /** Shares after conversion to common (s). Positive integer. */
  shares: BigIntLike;
  /** Aggregate liquidation preference in cents (L). Positive integer. */
  liquidation: BigIntLike;
  /** Whether the class participates in the remaining proceeds. */
  participating: boolean;
  /** Optional total-proceeds cap in cents (C). Only for participating classes; C >= L. */
  cap?: BigIntLike;
}

export interface CapitalTable {
  /** Common share count. Positive integer. */
  commonShares: BigIntLike;
  /** Preferred classes, all sharing one liquidation seniority. */
  preferred: PreferredClassInput[];
}

export interface PreferredAllocation {
  id: string;
  /** Exact proceeds in cents, as a reduced rational. */
  amount: Rational;
  /** Whether the class converts to common stock. */
  converted: boolean;
}

export interface Allocation {
  /** Exact common-stock proceeds in cents, as a reduced rational. */
  common: Rational;
  preferred: PreferredAllocation[];
}
