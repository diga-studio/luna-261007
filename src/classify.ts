import type { WorkSegment } from "./segment.js";

export const DAILY_OT_THRESHOLD_MINUTES = 480;
export const WEEKLY_OT_THRESHOLD_MINUTES = 2400;

export const enum MinuteKind {
  Regular = 0,
  DailyOvertime = 1,
  WeeklyOvertime = 2,
}

/** 带类别标记的段：同一来源段被拆成若干连续片段，每片同属一类。 */
export interface ClassifiedSegment {
  segment: WorkSegment;
  kind: MinuteKind;
  minutes: number;
}

interface Piece {
  segment: WorkSegment;
  minutes: number;
}

/**
 * 对一名员工一周内的段做日加班 / 周加班分类。
 * 输入段必须互不重叠且已按 startOffset 升序排列（时间顺序）。
 */
export function classifyWeek(
  segments: WorkSegment[],
  dailyOvertimeEnabled: boolean,
): ClassifiedSegment[] {
  // 第一趟：日加班。每日按时间顺序累计，超过阈值的部分标为日加班，其余进入周累计。
  const dailyCounted = new Map<number, number>();
  const nonDailyPieces: Piece[] = [];
  const result: ClassifiedSegment[] = [];
  for (const segment of segments) {
    if (!dailyOvertimeEnabled) {
      nonDailyPieces.push({ segment, minutes: segment.minutes });
      continue;
    }
    const counted = dailyCounted.get(segment.dayIndex) ?? 0;
    const regularPart = Math.max(0, Math.min(segment.minutes, DAILY_OT_THRESHOLD_MINUTES - counted));
    const overtimePart = segment.minutes - regularPart;
    dailyCounted.set(segment.dayIndex, counted + segment.minutes);
    if (regularPart > 0) {
      nonDailyPieces.push({ segment, minutes: regularPart });
    }
    if (overtimePart > 0) {
      result.push({ segment, kind: MinuteKind.DailyOvertime, minutes: overtimePart });
    }
  }

  // 第二趟：周加班。非日加班分钟按时间顺序累计，超过阈值的部分标为周加班。
  let weeklyCounted = 0;
  for (const piece of nonDailyPieces) {
    const regularPart = Math.max(0, Math.min(piece.minutes, WEEKLY_OT_THRESHOLD_MINUTES - weeklyCounted));
    const overtimePart = piece.minutes - regularPart;
    weeklyCounted += piece.minutes;
    if (regularPart > 0) {
      result.push({ segment: piece.segment, kind: MinuteKind.Regular, minutes: regularPart });
    }
    if (overtimePart > 0) {
      result.push({ segment: piece.segment, kind: MinuteKind.WeeklyOvertime, minutes: overtimePart });
    }
  }
  return result;
}
