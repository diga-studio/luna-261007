/** Gregorian calendar day, formatted as `YYYY-MM-DD`. */
export type ISODate = string;

/** An asset in the immutable collection. All money amounts are integer cents. */
export interface Asset {
  /** Unique asset identifier. */
  readonly id: string;
  /** Purchase (acquisition) date as a Gregorian calendar day. */
  readonly purchaseDate: ISODate;
  /** Purchase price P, in integer cents. */
  readonly price: number | bigint;
  /** Salvage value S, in integer cents. */
  readonly salvage: number | bigint;
  /** Depreciation life L, in months. */
  readonly lifeMonths: number;
  /** Declining-balance multiplier r in ten-thousandths: 20000 means 200%. */
  readonly rate: number;
}

/** A single book-value query: the book value of asset `id` at the end of `date`. */
export interface BookValueRequest {
  readonly id: string;
  readonly date: ISODate;
}
