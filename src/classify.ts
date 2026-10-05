import type { WorkSegment } from "./segments.js";

const MINUTES_PER_WEEK = 7 * 1440;
const DAILY_OT_THRESHOLD = 480;
const WEEKLY_OT_THRESHOLD = 2400;

/** Minutes of one segment falling into each class. */
export interface ClassifiedSegment {
  segment: WorkSegment;
  weekIndex: number;
  regularMinutes: number;
  dailyOtMinutes: number;
  weeklyOtMinutes: number;
}

/** Accumulator for one (employee, week, site, job) line. */
export interface LineBucket {
  employeeId: string;
  weekIndex: number;
  siteId: string;
  jobId: string;
  regularMinutes: number;
  dailyOtMinutes: number;
  weeklyOtMinutes: number;
  /** Sum of length * rateNumerator over all minutes; divide by 10000 for cent-minutes. */
  baseNumerator: bigint;
}

/** Accumulator for one (employee, week). */
export interface WeekBucket {
  employeeId: string;
  weekIndex: number;
  totalMinutes: number;
  totalBaseNumerator: bigint;
  lines: Map<string, LineBucket>;
}

function classifyWeek(segments: WorkSegment[], dailyOvertimeEnabled: boolean): ClassifiedSegment[] {
  const out: ClassifiedSegment[] = [];
  // Daily pass: minutes past 480 per calendar day, in true time order, become daily OT.
  const nonDaily = new Map<WorkSegment, number>();
  if (dailyOvertimeEnabled) {
    let currentDay = -1;
    let dayWorked = 0;
    for (const seg of segments) {
      if (seg.dayNumber !== currentDay) {
        currentDay = seg.dayNumber;
        dayWorked = 0;
      }
      const regularEligible = Math.max(0, Math.min(seg.length, DAILY_OT_THRESHOLD - dayWorked));
      nonDaily.set(seg, regularEligible);
      dayWorked += seg.length;
    }
  } else {
    for (const seg of segments) nonDaily.set(seg, seg.length);
  }
  // Weekly pass: non-daily-OT minutes past 2400 per week, in true time order, become weekly OT.
  let weekCounted = 0;
  for (const seg of segments) {
    const eligible = nonDaily.get(seg)!;
    const before = weekCounted;
    const after = before + eligible;
    const weeklyOt = Math.max(0, after - WEEKLY_OT_THRESHOLD) - Math.max(0, before - WEEKLY_OT_THRESHOLD);
    weekCounted = after;
    out.push({
      segment: seg,
      weekIndex: 0, // filled in by caller
      regularMinutes: eligible - weeklyOt,
      dailyOtMinutes: seg.length - eligible,
      weeklyOtMinutes: weeklyOt,
    });
  }
  return out;
}

/**
 * Classifies every segment and accumulates per (employee, week, site, job) buckets.
 * `segments` must be globally sorted by startAbs (buildSegments guarantees this).
 */
export function classifySegments(
  segments: WorkSegment[],
  periodStartAbs: number,
  dailyOvertimeEnabled: boolean,
): WeekBucket[] {
  const byEmployeeWeek = new Map<string, { employeeId: string; weekIndex: number; list: WorkSegment[] }>();
  for (const seg of segments) {
    const weekIndex = Math.floor((seg.startAbs - periodStartAbs) / MINUTES_PER_WEEK);
    const key = `${seg.employeeId}${weekIndex}`;
    let entry = byEmployeeWeek.get(key);
    if (!entry) {
      entry = { employeeId: seg.employeeId, weekIndex, list: [] };
      byEmployeeWeek.set(key, entry);
    }
    entry.list.push(seg);
  }

  const weeks: WeekBucket[] = [];
  for (const { employeeId, weekIndex, list } of byEmployeeWeek.values()) {
    // Segments were appended in global time order, so `list` is already chronological.
    const classified = classifyWeek(list, dailyOvertimeEnabled);
    const bucket: WeekBucket = {
      employeeId,
      weekIndex,
      totalMinutes: 0,
      totalBaseNumerator: 0n,
      lines: new Map(),
    };
    for (const c of classified) {
      const seg = c.segment;
      bucket.totalMinutes += seg.length;
      bucket.totalBaseNumerator += BigInt(seg.length) * seg.rateNumerator;
      const lineKey = `${seg.siteId}${seg.jobId}`;
      let line = bucket.lines.get(lineKey);
      if (!line) {
        line = {
          employeeId,
          weekIndex,
          siteId: seg.siteId,
          jobId: seg.jobId,
          regularMinutes: 0,
          dailyOtMinutes: 0,
          weeklyOtMinutes: 0,
          baseNumerator: 0n,
        };
        bucket.lines.set(lineKey, line);
      }
      line.regularMinutes += c.regularMinutes;
      line.dailyOtMinutes += c.dailyOtMinutes;
      line.weeklyOtMinutes += c.weeklyOtMinutes;
      line.baseNumerator += BigInt(seg.length) * seg.rateNumerator;
    }
    weeks.push(bucket);
  }
  return weeks;
}
