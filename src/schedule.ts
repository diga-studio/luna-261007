import type { Asset } from "./types.ts";
import { addMonthsClamped, parseISODate, type CalDate } from "./datemath.ts";

/** One depreciation posting: an entry booked on `date`, cumulative depreciation `cumDep`. */
export interface Posting {
  readonly date: CalDate;
  readonly cumDep: bigint;
}

/** Precomputed, immutable depreciation schedule for one asset. */
export interface AssetSchedule {
  readonly id: string;
  readonly purchaseDate: CalDate;
  readonly price: bigint;
  readonly salvage: bigint;
  /** Exactly L postings in chronological order; the last one lands on salvage. */
  readonly postings: readonly Posting[];
}

function toCents(value: number | bigint, field: string): bigint {
  if (typeof value === "bigint") return value;
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${field} must be an integer number of cents: ${value}`);
  }
  return BigInt(value);
}

/**
 * Computes the full depreciation schedule for one asset.
 *
 * Entry k (1-based) is booked exactly k months after the purchase date,
 * using the original purchase day-of-month (clamped to the target month's
 * last day, never carrying a clamped day into later entries).
 *
 * Entries 1..L-1 depreciate floor(bookValue * r / (10000 * L)) cents,
 * capped so the book value never drops below salvage. Entry L depreciates
 * whatever remains down to salvage. All arithmetic uses bigint, so every
 * intermediate product and quotient is exact.
 */
export function buildSchedule(asset: Asset): AssetSchedule {
  if (!Number.isInteger(asset.lifeMonths) || asset.lifeMonths < 1) {
    throw new RangeError(`lifeMonths must be a positive integer: ${asset.lifeMonths}`);
  }
  if (!Number.isInteger(asset.rate) || asset.rate < 0) {
    throw new RangeError(`rate must be a non-negative integer: ${asset.rate}`);
  }
  const price = toCents(asset.price, "price");
  const salvage = toCents(asset.salvage, "salvage");
  if (salvage < 0n || price < salvage) {
    throw new RangeError(`expected 0 <= salvage <= price, got salvage=${salvage} price=${price}`);
  }

  const purchaseDate = parseISODate(asset.purchaseDate);
  const life = BigInt(asset.lifeMonths);
  const rate = BigInt(asset.rate);
  const denominator = 10000n * life;

  const postings: Posting[] = [];
  let bookValue = price;
  let cumDep = 0n;
  for (let k = 1; k <= asset.lifeMonths; k += 1) {
    let dep: bigint;
    if (k < asset.lifeMonths) {
      dep = (bookValue * rate) / denominator;
      const maxDep = bookValue - salvage;
      if (dep > maxDep) dep = maxDep;
    } else {
      dep = bookValue - salvage;
    }
    bookValue -= dep;
    cumDep += dep;
    postings.push(Object.freeze({ date: addMonthsClamped(purchaseDate, k), cumDep }));
  }
  Object.freeze(postings);

  return Object.freeze({
    id: asset.id,
    purchaseDate,
    price,
    salvage,
    postings,
  });
}
