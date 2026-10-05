import type { Asset, BookValueRequest } from "./types.ts";
import { compareDates, parseISODate } from "./datemath.ts";
import { buildSchedule, type AssetSchedule } from "./schedule.ts";

export type { Asset, BookValueRequest, ISODate } from "./types.ts";

/**
 * Immutable handle over a built asset collection.
 * Contains only precomputed data; no query work happens at build time.
 */
export interface DepreciationBook {
  readonly schedules: ReadonlyMap<string, AssetSchedule>;
}

/** Builds an immutable handle for the given asset collection. Performs no queries. */
export function build(assets: readonly Asset[]): DepreciationBook {
  const schedules = new Map<string, AssetSchedule>();
  for (const asset of assets) {
    if (schedules.has(asset.id)) {
      throw new RangeError(`duplicate asset id: ${JSON.stringify(asset.id)}`);
    }
    schedules.set(asset.id, buildSchedule(asset));
  }
  return Object.freeze({ schedules });
}

/** Index of the last posting booked on or before `date`, or -1 if none. */
function lastPostingIndex(schedule: AssetSchedule, date: Parameters<typeof compareDates>[0]): number {
  const postings = schedule.postings;
  let lo = 0;
  let hi = postings.length; // invariant: postings[lo-1] <= date < postings[hi]
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const posting = postings[mid];
    if (posting !== undefined && compareDates(posting.date, date) <= 0) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo - 1;
}

/**
 * Answers a batch of book-value queries against a built handle.
 * Returns one result per request, in request order: the book value in integer
 * cents at the end of the request date, or `null` before the purchase date.
 * The handle is not modified; results do not depend on request order,
 * duplicates, or previously answered batches.
 */
export function bookValues(
  book: DepreciationBook,
  requests: readonly BookValueRequest[],
): (bigint | null)[] {
  return requests.map((request) => {
    const schedule = book.schedules.get(request.id);
    if (schedule === undefined) {
      throw new RangeError(`unknown asset id: ${JSON.stringify(request.id)}`);
    }
    const date = parseISODate(request.date);
    if (compareDates(date, schedule.purchaseDate) < 0) {
      return null;
    }
    const index = lastPostingIndex(schedule, date);
    if (index < 0) {
      return schedule.price;
    }
    const posting = schedule.postings[index];
    if (posting === undefined) {
      throw new Error("unreachable: posting index out of range");
    }
    return schedule.price - posting.cumDep;
  });
}
