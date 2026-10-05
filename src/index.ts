import type {
  EmployeeTotal,
  LocalDate,
  PayLine,
  PayRunResult,
  PayRules,
  ShiftRecord,
} from "./types.js";
import { addDays, toAbsoluteMinute } from "./time.js";
import { buildSegments } from "./segments.js";
import { classifySegments, type WeekBucket } from "./classify.js";
import { allocateCents, roundHalfUp } from "./money.js";

export type { PayRunResult, PayRules, ShiftRecord, LocalDate };
export * from "./types.js";

const MINUTES_PER_WEEK = 7 * 1440;
/** Fine units per cent for base pay: rate numerator is rateCents * 10000, per hour. */
const BASE_UNITS_PER_CENT = 600_000n;
/** Fine units per cent for OT premium: premium per OT minute = weekBase / (120 * totalMinutes). */
const PREMIUM_FACTOR = 1_200_000n;

interface WeekMoney {
  bucket: WeekBucket;
  lines: PayLine[];
  basePayCents: bigint;
  overtimePremiumCents: bigint;
}

function settleWeek(periodStart: LocalDate, bucket: WeekBucket): WeekMoney {
  const weekStart = addDays(periodStart, bucket.weekIndex * 7);
  const totalOtMinutes = bucket.totalMinutes === 0
    ? 0
    : [...bucket.lines.values()].reduce((sum, l) => sum + l.dailyOtMinutes + l.weeklyOtMinutes, 0);

  const basePayCents = roundHalfUp(bucket.totalBaseNumerator, BASE_UNITS_PER_CENT);
  const premiumNumerator = BigInt(totalOtMinutes) * bucket.totalBaseNumerator;
  const premiumDenominator = bucket.totalMinutes === 0
    ? 1n
    : PREMIUM_FACTOR * BigInt(bucket.totalMinutes);
  const overtimePremiumCents = bucket.totalMinutes === 0
    ? 0n
    : roundHalfUp(premiumNumerator, premiumDenominator);

  const sortedLines = [...bucket.lines.values()].sort((a, b) =>
    a.siteId === b.siteId ? (a.jobId < b.jobId ? -1 : 1) : a.siteId < b.siteId ? -1 : 1,
  );
  const baseAlloc = allocateCents(
    sortedLines.map((l) => ({ units: l.baseNumerator })),
    BASE_UNITS_PER_CENT,
    basePayCents,
  );
  const premiumAlloc = allocateCents(
    sortedLines.map((l) => ({
      units: BigInt(l.dailyOtMinutes + l.weeklyOtMinutes) * bucket.totalBaseNumerator,
    })),
    premiumDenominator,
    overtimePremiumCents,
  );

  const lines: PayLine[] = sortedLines.map((l, i) => ({
    employeeId: l.employeeId,
    weekIndex: l.weekIndex,
    weekStart,
    siteId: l.siteId,
    jobId: l.jobId,
    regularMinutes: l.regularMinutes,
    dailyOtMinutes: l.dailyOtMinutes,
    weeklyOtMinutes: l.weeklyOtMinutes,
    basePayCents: Number(baseAlloc[i]),
    overtimePremiumCents: Number(premiumAlloc[i]),
  }));
  return { bucket, lines, basePayCents, overtimePremiumCents };
}

export function calculatePayRun(
  periodStart: LocalDate,
  weeks: 1 | 2,
  shifts: ShiftRecord[],
  rules: PayRules,
): PayRunResult {
  const periodStartAbs = toAbsoluteMinute({ date: periodStart, minute: 0 });
  const periodEndAbs = periodStartAbs + weeks * MINUTES_PER_WEEK;

  const segments = buildSegments(shifts, rules, periodStartAbs, periodEndAbs);
  const weekBuckets = classifySegments(segments, periodStartAbs, rules.dailyOvertimeEnabled);

  const settled = weekBuckets.map((b) => settleWeek(periodStart, b));
  const lines = settled
    .flatMap((w) => w.lines)
    .sort((a, b) => {
      if (a.employeeId !== b.employeeId) return a.employeeId < b.employeeId ? -1 : 1;
      if (a.weekIndex !== b.weekIndex) return a.weekIndex - b.weekIndex;
      if (a.siteId !== b.siteId) return a.siteId < b.siteId ? -1 : 1;
      return a.jobId < b.jobId ? -1 : 1;
    });

  const totals = new Map<string, EmployeeTotal>();
  for (const w of settled) {
    const id = w.bucket.employeeId;
    let t = totals.get(id);
    if (!t) {
      t = {
        employeeId: id,
        regularMinutes: 0,
        dailyOtMinutes: 0,
        weeklyOtMinutes: 0,
        basePayCents: 0,
        overtimePremiumCents: 0,
        totalCents: 0,
      };
      totals.set(id, t);
    }
    for (const l of w.lines) {
      t.regularMinutes += l.regularMinutes;
      t.dailyOtMinutes += l.dailyOtMinutes;
      t.weeklyOtMinutes += l.weeklyOtMinutes;
      t.basePayCents += l.basePayCents;
      t.overtimePremiumCents += l.overtimePremiumCents;
    }
  }
  const employeeTotals = [...totals.values()]
    .map((t) => ({ ...t, totalCents: t.basePayCents + t.overtimePremiumCents }))
    .sort((a, b) => (a.employeeId < b.employeeId ? -1 : 1));

  return { lines, employeeTotals };
}
