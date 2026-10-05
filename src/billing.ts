import type { Snapshot, Tier } from './types.js';

export interface EffectiveChange {
  at: number;
  snapshot: Snapshot;
}

const MONTH_PRICE_CENTS: Record<Tier, number> = {
  starter: 2900,
  growth: 9900,
  enterprise: 29900,
};

const BASELINE_CPU: Record<Tier, number> = {
  starter: 1,
  growth: 4,
  enterprise: 8,
};

const EXTRA_CPU_CENTS_PER_HOUR = 500;
const HOUR_MS = 3_600_000;

/** "YYYY-MM" key for a UTC instant. */
export function monthKeyOf(ms: number): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  return `${y.toString().padStart(4, '0')}-${m.toString().padStart(2, '0')}`;
}

/** Start-of-month UTC ms for a "YYYY-MM" key. */
export function monthStartMs(month: string): number {
  const [y, m] = month.split('-').map(Number);
  return Date.UTC(y, m - 1, 1);
}

/** Advance a "YYYY-MM" key by one month. */
export function nextMonthKey(month: string): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m, 1)); // m is 1-based here: Date.UTC month is 0-based, so m === next month
  return monthKeyOf(d.getTime());
}

/**
 * Compute the rounded integer cents owed for one instance in one UTC month.
 *
 * `timeline` holds the effective (highest-revision, non-revoked) changes
 * sorted by `at`; each entry bills from its `at` up to the next entry's `at`.
 * Only the window [monthStart, min(monthEnd, until)) is considered, and only
 * `running` segments are billed. Base price is prorated by the actual
 * millisecond length of the month; CPU above the tier baseline is billed per
 * unit-hour. The exact sum is rounded half-up to integer cents.
 */
export function computeMonthCents(
  timeline: EffectiveChange[],
  monthStart: number,
  until: number,
): number {
  const monthEnd = monthStartMs(nextMonthKey(monthKeyOf(monthStart)));
  const windowStart = monthStart;
  const windowEnd = Math.min(monthEnd, until);
  if (windowEnd <= windowStart) return 0;

  const monthLength = monthEnd - monthStart;
  // Exact rational accumulator: total cents = numerator / denominator.
  const denominator = BigInt(monthLength) * BigInt(HOUR_MS);
  let numerator = 0n;

  for (let i = 0; i < timeline.length; i++) {
    const segStart = Math.max(timeline[i].at, windowStart);
    const nextAt = i + 1 < timeline.length ? timeline[i + 1].at : Number.POSITIVE_INFINITY;
    const segEnd = Math.min(nextAt, windowEnd);
    if (segEnd <= segStart) continue;

    const snap = timeline[i].snapshot;
    if (snap.state !== 'running') continue;

    const ms = BigInt(segEnd - segStart);
    const price = BigInt(MONTH_PRICE_CENTS[snap.tier]);
    const extraCpu = Math.max(0, snap.cpu - BASELINE_CPU[snap.tier]);
    // base: ms * price / monthLength  ->  ms * price * HOUR_MS / denominator
    numerator += ms * price * BigInt(HOUR_MS);
    // extra: ms * extraCpu * 500 / HOUR_MS  ->  ms * extraCpu * 500 * monthLength / denominator
    numerator += ms * BigInt(extraCpu * EXTRA_CPU_CENTS_PER_HOUR) * BigInt(monthLength);
  }

  if (numerator === 0n) return 0;
  // Round half up: floor((2n + d) / 2d).
  return Number((2n * numerator + denominator) / (2n * denominator));
}
