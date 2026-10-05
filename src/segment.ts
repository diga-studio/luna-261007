import { MINUTES_PER_DAY, MINUTES_PER_WEEK, localTimeToAbsMinute } from "./time.js";
import type { MinimumRate, ShiftRecord } from "./types.js";

/** 一段不跨午夜的工时，费率已确定。周界即周一零点，必为午夜，故不跨午夜即不跨周界。 */
export interface WorkSegment {
  employeeId: string;
  siteId: string;
  jobId: string;
  /** 段起点，自 periodStart 起的分钟偏移。 */
  startOffset: number;
  minutes: number;
  /** 自 periodStart 起的天数（0 起）。 */
  dayIndex: number;
  /** 自 periodStart 起的周数（0 起）。 */
  weekIndex: number;
  /** 有效时薪分子：max(基础时薪, 最低时薪) * (10000 + 班次差异基点)，分母固定 10000。 */
  rateNumerator: number;
}

/** 把工时记录裁剪到核算区间，并按午夜拆分为段。输出顺序与输入无关地确定。 */
export function buildSegments(
  shifts: ShiftRecord[],
  minimumRates: MinimumRate[],
  periodStartAbsMinute: number,
  periodMinutes: number,
): WorkSegment[] {
  const rateMap = new Map<string, number>();
  for (const rate of minimumRates) {
    rateMap.set(`${rate.siteId} ${rate.jobId}`, rate.rateCents);
  }

  const segments: WorkSegment[] = [];
  for (const shift of shifts) {
    const shiftStart = localTimeToAbsMinute(shift.start);
    const shiftEnd = localTimeToAbsMinute(shift.end);
    const clipStart = Math.max(shiftStart, periodStartAbsMinute);
    const clipEnd = Math.min(shiftEnd, periodStartAbsMinute + periodMinutes);
    if (clipEnd <= clipStart) {
      continue;
    }
    const minimum = rateMap.get(`${shift.siteId} ${shift.jobId}`) ?? 0;
    const effectiveCents = Math.max(shift.baseRateCents, minimum);
    const rateNumerator = effectiveCents * (10000 + shift.shiftDiffBps);

    let cursor = clipStart;
    while (cursor < clipEnd) {
      const offset = cursor - periodStartAbsMinute;
      const dayIndex = Math.floor(offset / MINUTES_PER_DAY);
      const dayEndOffset = (dayIndex + 1) * MINUTES_PER_DAY;
      const segmentMinutes = Math.min(clipEnd - cursor, dayEndOffset - offset);
      segments.push({
        employeeId: shift.employeeId,
        siteId: shift.siteId,
        jobId: shift.jobId,
        startOffset: offset,
        minutes: segmentMinutes,
        dayIndex,
        weekIndex: Math.floor(offset / MINUTES_PER_WEEK),
        rateNumerator,
      });
      cursor += segmentMinutes;
    }
  }

  // 排序只依赖时间、工地、工种与费率，与输入顺序及记录拆分无关。
  segments.sort(
    (a, b) =>
      a.employeeId.localeCompare(b.employeeId) ||
      a.startOffset - b.startOffset ||
      a.siteId.localeCompare(b.siteId) ||
      a.jobId.localeCompare(b.jobId) ||
      a.rateNumerator - b.rateNumerator,
  );
  return segments;
}
