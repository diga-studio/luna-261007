import { classifyWeek, MinuteKind } from "./classify.js";
import { allocateRounded, rational, roundHalfUp, type Rational } from "./money.js";
import { buildSegments, type WorkSegment } from "./segment.js";
import { MINUTES_PER_WEEK, dateToDayNumber, dayNumberToDate, localTimeToAbsMinute } from "./time.js";
import type { EmployeeTotal, PayLine, PayRules, PayRunResult, ShiftRecord } from "./types.js";

/** 有效时薪分母：班次差异基点（10000）* 每小时分钟数（60）。 */
const BASE_PAY_DENOMINATOR = 600000n;

interface LineBucket {
  siteId: string;
  jobId: string;
  regularMinutes: number;
  dailyOvertimeMinutes: number;
  weeklyOvertimeMinutes: number;
  /** 基础工资分子：sum(分钟 * 费率分子)，分母为 BASE_PAY_DENOMINATOR。 */
  baseNumerator: bigint;
  overtimeMinutes: number;
}

interface WeekComputation {
  lines: PayLine[];
  basePayCents: number;
  overtimePremiumCents: number;
  regularMinutes: number;
  dailyOvertimeMinutes: number;
  weeklyOvertimeMinutes: number;
}

function computeWeek(
  employeeId: string,
  weekIndex: number,
  weekStartDate: string,
  segments: WorkSegment[],
  dailyOvertimeEnabled: boolean,
): WeekComputation {
  const classified = classifyWeek(segments, dailyOvertimeEnabled);

  let totalMinutes = 0;
  let totalBaseNumerator = 0n;
  const buckets = new Map<string, LineBucket>();
  for (const piece of classified) {
    const { segment } = piece;
    totalMinutes += piece.minutes;
    totalBaseNumerator += BigInt(piece.minutes) * BigInt(segment.rateNumerator);
    const key = `${segment.siteId} ${segment.jobId}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        siteId: segment.siteId,
        jobId: segment.jobId,
        regularMinutes: 0,
        dailyOvertimeMinutes: 0,
        weeklyOvertimeMinutes: 0,
        baseNumerator: 0n,
        overtimeMinutes: 0,
      };
      buckets.set(key, bucket);
    }
    bucket.baseNumerator += BigInt(piece.minutes) * BigInt(segment.rateNumerator);
    if (piece.kind === MinuteKind.Regular) {
      bucket.regularMinutes += piece.minutes;
    } else if (piece.kind === MinuteKind.DailyOvertime) {
      bucket.dailyOvertimeMinutes += piece.minutes;
      bucket.overtimeMinutes += piece.minutes;
    } else {
      bucket.weeklyOvertimeMinutes += piece.minutes;
      bucket.overtimeMinutes += piece.minutes;
    }
  }

  // 周常规时薪 = 该周全部基础工资 / 全部工作小时数；
  // 每个加班分钟的增额 = 常规时薪的 0.5 倍 / 60 = 周基础工资 / (2 * 总分钟数)。
  const totalBase = rational(totalBaseNumerator, BASE_PAY_DENOMINATOR);
  const premiumDenominator = 2n * BASE_PAY_DENOMINATOR * BigInt(totalMinutes);

  const bucketList = [...buckets.values()].sort(
    (a, b) => a.siteId.localeCompare(b.siteId) || a.jobId.localeCompare(b.jobId),
  );
  const tieBreakKeys = bucketList.map((b) => `${b.siteId} ${b.jobId}`);

  const baseUnrounded: Rational[] = bucketList.map((b) => rational(b.baseNumerator, BASE_PAY_DENOMINATOR));
  const premiumUnrounded: Rational[] = bucketList.map((b) =>
    rational(BigInt(b.overtimeMinutes) * totalBaseNumerator, premiumDenominator),
  );

  const baseRoundedTotal = roundHalfUp(totalBase);
  const premiumRoundedTotal = roundHalfUp(
    rational(
      BigInt(bucketList.reduce((acc, b) => acc + b.overtimeMinutes, 0)) * totalBaseNumerator,
      premiumDenominator,
    ),
  );

  const baseAllocated = allocateRounded(baseUnrounded, baseRoundedTotal, tieBreakKeys);
  const premiumAllocated = allocateRounded(premiumUnrounded, premiumRoundedTotal, tieBreakKeys);

  const lines: PayLine[] = bucketList.map((bucket, index) => ({
    employeeId,
    weekIndex,
    weekStart: weekStartDate,
    siteId: bucket.siteId,
    jobId: bucket.jobId,
    regularMinutes: bucket.regularMinutes,
    dailyOvertimeMinutes: bucket.dailyOvertimeMinutes,
    weeklyOvertimeMinutes: bucket.weeklyOvertimeMinutes,
    basePayCents: Number(baseAllocated[index]),
    overtimePremiumCents: Number(premiumAllocated[index]),
  }));

  return {
    lines,
    basePayCents: Number(baseRoundedTotal),
    overtimePremiumCents: Number(premiumRoundedTotal),
    regularMinutes: bucketList.reduce((acc, b) => acc + b.regularMinutes, 0),
    dailyOvertimeMinutes: bucketList.reduce((acc, b) => acc + b.dailyOvertimeMinutes, 0),
    weeklyOvertimeMinutes: bucketList.reduce((acc, b) => acc + b.weeklyOvertimeMinutes, 0),
  };
}

export function calculatePayRun(
  periodStart: string,
  weeks: 1 | 2,
  shifts: ShiftRecord[],
  rules: PayRules,
): PayRunResult {
  const periodStartAbsMinute = localTimeToAbsMinute({ date: periodStart, minute: 0 });
  const periodMinutes = weeks * MINUTES_PER_WEEK;
  const segments = buildSegments(shifts, rules.minimumRates, periodStartAbsMinute, periodMinutes);

  // 按员工、周分组（段已按员工与时间排序，分组保持时间顺序）。
  const groups = new Map<string, WorkSegment[]>();
  for (const segment of segments) {
    const key = `${segment.employeeId} ${segment.weekIndex}`;
    const group = groups.get(key);
    if (group) {
      group.push(segment);
    } else {
      groups.set(key, [segment]);
    }
  }

  const lines: PayLine[] = [];
  const totalsByEmployee = new Map<string, EmployeeTotal>();
  const sortedGroupKeys = [...groups.keys()].sort();
  for (const key of sortedGroupKeys) {
    const group = groups.get(key)!;
    const first = group[0]!;
    const weekStartDate = dayNumberToDate(dateToDayNumber(periodStart) + first.weekIndex * 7);
    const week = computeWeek(
      first.employeeId,
      first.weekIndex,
      weekStartDate,
      group,
      rules.dailyOvertimeEnabled,
    );
    lines.push(...week.lines);

    let total = totalsByEmployee.get(first.employeeId);
    if (!total) {
      total = {
        employeeId: first.employeeId,
        regularMinutes: 0,
        dailyOvertimeMinutes: 0,
        weeklyOvertimeMinutes: 0,
        basePayCents: 0,
        overtimePremiumCents: 0,
      };
      totalsByEmployee.set(first.employeeId, total);
    }
    total.regularMinutes += week.regularMinutes;
    total.dailyOvertimeMinutes += week.dailyOvertimeMinutes;
    total.weeklyOvertimeMinutes += week.weeklyOvertimeMinutes;
    total.basePayCents += week.basePayCents;
    total.overtimePremiumCents += week.overtimePremiumCents;
  }

  const totals = [...totalsByEmployee.values()].sort((a, b) => a.employeeId.localeCompare(b.employeeId));
  return { lines, totals };
}
