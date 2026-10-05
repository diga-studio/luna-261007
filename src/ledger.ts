import { FixedShift, InvitationRecord, Minute } from './types';
import { overlaps, splitByWeek, WEEKLY_CAP_MINUTES } from './time';

export interface Interval {
  start: Minute;
  end: Minute;
}

/**
 * 工分台账：对单个员工，把固定排班与有效邀约合并，
 * 提供重叠检查与逐周额度检查。
 */
export class OccupancyLedger {
  private readonly intervals: Interval[];
  private readonly weeklyMinutes: Map<number, number>;

  constructor(shifts: Interval[]) {
    this.intervals = shifts.slice();
    this.weeklyMinutes = new Map<number, number>();
    for (const interval of shifts) {
      for (const [week, minutes] of splitByWeek(interval.start, interval.end)) {
        this.weeklyMinutes.set(week, (this.weeklyMinutes.get(week) ?? 0) + minutes);
      }
    }
  }

  /** 新区间是否与已有占用重叠。 */
  hasOverlap(start: Minute, end: Minute): boolean {
    for (const interval of this.intervals) {
      if (overlaps(interval.start, interval.end, start, end)) return true;
    }
    return false;
  }

  /** 若加入新区间，逐周工时是否仍不超过上限（恰好等于允许）。 */
  fitsWeeklyCap(start: Minute, end: Minute): boolean {
    for (const [week, minutes] of splitByWeek(start, end)) {
      const existing = this.weeklyMinutes.get(week) ?? 0;
      if (existing + minutes > WEEKLY_CAP_MINUTES) return false;
    }
    return true;
  }
}

/** 按员工分组固定排班。 */
export function groupShiftsByEmployee(shifts: FixedShift[]): Map<string, Interval[]> {
  const grouped = new Map<string, Interval[]>();
  for (const shift of shifts) {
    const list = grouped.get(shift.employeeId);
    const interval = { start: shift.start, end: shift.end };
    if (list) list.push(interval);
    else grouped.set(shift.employeeId, [interval]);
  }
  return grouped;
}

/** 按员工分组邀约区间。 */
export function groupInvitationsByEmployee(invitations: InvitationRecord[]): Map<string, Interval[]> {
  const grouped = new Map<string, Interval[]>();
  for (const invitation of invitations) {
    const list = grouped.get(invitation.employeeId);
    const interval = { start: invitation.start, end: invitation.end };
    if (list) list.push(interval);
    else grouped.set(invitation.employeeId, [interval]);
  }
  return grouped;
}
