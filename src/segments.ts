import type { PayRules, ShiftRecord } from "./types.js";
import { toAbsoluteMinute } from "./time.js";

const MINUTES_PER_DAY = 1440;

/**
 * One maximal run of minutes inside a single calendar day, coming from one record.
 * Splitting at midnight (never inside a day) keeps the true time attribution of
 * every minute and makes the result independent of how the input was split.
 */
export interface WorkSegment {
  employeeId: string;
  siteId: string;
  jobId: string;
  /** Absolute minute index of the segment start. */
  startAbs: number;
  /** Segment length in minutes (> 0), never crossing midnight. */
  length: number;
  /** Calendar day number (days since epoch) the segment belongs to. */
  dayNumber: number;
  /** Effective hourly rate numerator: rateCents * (10000 + shiftDiffBps). Divide by 10000 for cents. */
  rateNumerator: bigint;
}

function minimumRateFor(rules: PayRules, siteId: string, jobId: string): number {
  let rate = 0;
  for (const m of rules.minimumRates) {
    if (m.siteId === siteId && m.jobId === jobId && m.rateCents > rate) {
      rate = m.rateCents;
    }
  }
  return rate;
}

export function effectiveRateNumerator(rules: PayRules, shift: ShiftRecord): bigint {
  const base = Math.max(shift.baseRateCents, minimumRateFor(rules, shift.siteId, shift.jobId));
  return BigInt(base) * BigInt(10_000 + shift.shiftDiffBps);
}

/**
 * Clips every record to [periodStartAbs, periodStartAbs + weeks*7*1440) and splits
 * the remainder at midnight boundaries. Output is sorted deterministically by
 * (startAbs, endAbs, siteId, jobId, rateNumerator) so neither input order nor
 * lossless re-splitting of records can change downstream results.
 */
export function buildSegments(
  shifts: ShiftRecord[],
  rules: PayRules,
  periodStartAbs: number,
  periodEndAbs: number,
): WorkSegment[] {
  const segments: WorkSegment[] = [];
  for (const shift of shifts) {
    const rateNumerator = effectiveRateNumerator(rules, shift);
    let cursor = Math.max(toAbsoluteMinute(shift.start), periodStartAbs);
    const end = Math.min(toAbsoluteMinute(shift.end), periodEndAbs);
    while (cursor < end) {
      const dayNumber = Math.floor(cursor / MINUTES_PER_DAY);
      const dayEnd = (dayNumber + 1) * MINUTES_PER_DAY;
      const segEnd = Math.min(end, dayEnd);
      segments.push({
        employeeId: shift.employeeId,
        siteId: shift.siteId,
        jobId: shift.jobId,
        startAbs: cursor,
        length: segEnd - cursor,
        dayNumber,
        rateNumerator,
      });
      cursor = segEnd;
    }
  }
  segments.sort((a, b) => {
    if (a.startAbs !== b.startAbs) return a.startAbs - b.startAbs;
    if (a.length !== b.length) return a.length - b.length;
    if (a.siteId !== b.siteId) return a.siteId < b.siteId ? -1 : 1;
    if (a.jobId !== b.jobId) return a.jobId < b.jobId ? -1 : 1;
    if (a.rateNumerator !== b.rateNumerator) return a.rateNumerator < b.rateNumerator ? -1 : 1;
    return 0;
  });
  return segments;
}
