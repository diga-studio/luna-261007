import type { OwnershipInterval } from './types.js';

/**
 * Validate a full replacement timeline for one IP.
 * Intervals are [startMs, endMs), may have gaps, must not overlap.
 * Throws on invalid input; returns a copy sorted by startMs.
 */
export function validateTimeline(intervals: OwnershipInterval[]): OwnershipInterval[] {
  const sorted = intervals.map((iv) => ({ ...iv })).sort((a, b) => a.startMs - b.startMs);
  let prevEnd = Number.NEGATIVE_INFINITY;
  for (const iv of sorted) {
    if (!Number.isFinite(iv.startMs) || iv.startMs < 0) {
      throw new Error(`invalid interval start: ${iv.startMs}`);
    }
    if (iv.endMs !== null && (!Number.isFinite(iv.endMs) || iv.endMs <= iv.startMs)) {
      throw new Error(`interval end must be greater than start: [${iv.startMs}, ${iv.endMs})`);
    }
    if (typeof iv.assetId !== 'string' || iv.assetId.length === 0) {
      throw new Error('interval assetId must be a non-empty string');
    }
    if (iv.startMs < prevEnd) {
      throw new Error(`overlapping intervals at startMs=${iv.startMs}`);
    }
    prevEnd = iv.endMs === null ? Number.POSITIVE_INFINITY : iv.endMs;
  }
  return sorted;
}

/**
 * Find the asset owning an IP at `atMs` within a validated, start-sorted
 * timeline. Returns null when the instant falls into a gap.
 */
export function lookupOwner(
  sortedIntervals: OwnershipInterval[],
  atMs: number,
): string | null {
  let lo = 0;
  let hi = sortedIntervals.length - 1;
  let candidate = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sortedIntervals[mid].startMs <= atMs) {
      candidate = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (candidate < 0) return null;
  const iv = sortedIntervals[candidate];
  if (iv.endMs !== null && atMs >= iv.endMs) return null;
  return iv.assetId;
}
