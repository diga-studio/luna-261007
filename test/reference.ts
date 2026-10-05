import type { Asset } from "../src/types.ts";

// Self-contained calendar helpers: the reference deliberately does not reuse
// the library's date math, so a bug there cannot be masked by shared code.

function leap(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function monthLength(year: number, month: number): number {
  const lengths = [31, leap(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const length = lengths[month - 1];
  if (length === undefined) throw new RangeError(`bad month ${month}`);
  return length;
}

/** Parses 'YYYY-MM-DD' into a comparable day number and its parts. */
function parse(text: string): { ord: number; year: number; month: number; day: number } {
  const [ys, ms, ds] = text.split("-");
  const year = Number(ys);
  const month = Number(ms);
  const day = Number(ds);
  return { ord: year * 372 + (month - 1) * 31 + day, year, month, day };
}

/** Booking date of entry k: purchase date plus k months, clamped to month end. */
function bookingDate(purchase: { year: number; month: number; day: number }, k: number): number {
  const total = purchase.year * 12 + (purchase.month - 1) + k;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  const day = Math.min(purchase.day, monthLength(year, month));
  return year * 372 + (month - 1) * 31 + day;
}

/**
 * Independent month-by-month reference implementation.
 * Simulates one depreciation entry at a time, booking each entry exactly
 * k months after purchase, and reports the book value at the end of `date`.
 * Returns `null` when `date` is before the purchase date.
 */
export function referenceBookValue(asset: Asset, date: string): bigint | null {
  const purchase = parse(asset.purchaseDate);
  const query = parse(date);
  if (query.ord < purchase.ord) return null;

  let bookValue = BigInt(asset.price);
  const salvage = BigInt(asset.salvage);
  const life = asset.lifeMonths;
  const denominator = 10000n * BigInt(life);
  const rate = BigInt(asset.rate);

  for (let k = 1; k <= life; k += 1) {
    if (bookingDate(purchase, k) > query.ord) break;
    let dep: bigint;
    if (k < life) {
      dep = (bookValue * rate) / denominator;
      const maxDep = bookValue - salvage;
      if (dep > maxDep) dep = maxDep;
    } else {
      dep = bookValue - salvage;
    }
    bookValue -= dep;
  }
  return bookValue;
}
