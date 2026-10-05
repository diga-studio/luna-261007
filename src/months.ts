import type { Month } from "./types.js";

function toIndex(month: Month): number {
  const [year, mon] = month.split("-").map(Number);
  return year * 12 + (mon - 1);
}

function fromIndex(index: number): Month {
  const year = Math.floor(index / 12);
  const mon = (index % 12) + 1;
  return `${year}-${String(mon).padStart(2, "0")}`;
}

/** Number of calendar months from `from` to `to` inclusive; 0 if to < from. */
export function monthsBetweenInclusive(from: Month, to: Month): number {
  return Math.max(0, toIndex(to) - toIndex(from) + 1);
}

/** Subtract `n` calendar months from `month`. */
export function subMonths(month: Month, n: number): Month {
  return fromIndex(toIndex(month) - n);
}

/** List the `count` months ending at (and including) `baseline`, ascending. */
export function windowMonths(baseline: Month, count: number): Month[] {
  const end = toIndex(baseline);
  return Array.from({ length: count }, (_, i) => fromIndex(end - count + 1 + i));
}
