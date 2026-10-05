import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FixedShift,
  InvitationRecord,
  Opening,
  ShiftCoverService,
  StaticContext,
} from '../src/index';
import { splitByWeek, WEEKLY_CAP_MINUTES } from '../src/time';
import { overlaps } from '../src/time';

/** 第 week 个工作周的周一 00:00 UTC（分钟）。 */
export function monday(week: number): number {
  return week * 7 * 24 * 60 - 3 * 24 * 60;
}

export const WEEK0 = monday(2900);

export interface TestWorld {
  dir: string;
  dbPath: string;
  context: StaticContext;
  service: ShiftCoverService;
  cleanup: () => void;
}

export function makeWorld(context: StaticContext, name: string): TestWorld {
  const dir = mkdtempSync(join(tmpdir(), `shiftcover-${name}-`));
  const dbPath = join(dir, 'state.db');
  const service = new ShiftCoverService({ dbPath, context });
  return {
    dir,
    dbPath,
    context,
    service,
    cleanup: () => {
      try {
        service.close();
      } catch {
        // 已关闭
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function emp(id: string, qualifications: string[] = ['Q']): { id: string; qualifications: string[] } {
  return { id, qualifications };
}

export function opening(
  id: string,
  start: number,
  end: number,
  requiredQualifications: string[] = ['Q'],
): Opening {
  return { id, start, end, requiredQualifications };
}

export function shift(employeeId: string, start: number, end: number): FixedShift {
  return { employeeId, start, end };
}

/**
 * 独立重算校验：按原排班 + 库中有效邀约逐周重算，
 * 断言没有超额、重叠、空缺重复占用。
 */
export function assertConsistentOccupancy(
  context: StaticContext,
  active: InvitationRecord[],
): void {
  // 每个空缺最多一个有效邀约
  const byOpening = new Map<string, number>();
  for (const inv of active) {
    byOpening.set(inv.openingId, (byOpening.get(inv.openingId) ?? 0) + 1);
  }
  for (const [openingId, count] of byOpening) {
    if (count > 1) throw new Error(`opening ${openingId} occupied ${count} times`);
  }

  const intervalsByEmployee = new Map<string, { start: number; end: number }[]>();
  const push = (employeeId: string, start: number, end: number) => {
    const list = intervalsByEmployee.get(employeeId);
    if (list) list.push({ start, end });
    else intervalsByEmployee.set(employeeId, [{ start, end }]);
  };
  for (const s of context.fixedShifts) push(s.employeeId, s.start, s.end);
  for (const inv of active) push(inv.employeeId, inv.start, inv.end);

  for (const [employeeId, intervals] of intervalsByEmployee) {
    const sorted = intervals.slice().sort((a, b) => a.start - b.start);
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1]!;
      const curr = sorted[i]!;
      if (overlaps(prev.start, prev.end, curr.start, curr.end)) {
        throw new Error(`employee ${employeeId} has overlapping occupancy`);
      }
    }
    const weekly = new Map<number, number>();
    for (const interval of intervals) {
      for (const [week, minutes] of splitByWeek(interval.start, interval.end)) {
        weekly.set(week, (weekly.get(week) ?? 0) + minutes);
      }
    }
    for (const [week, minutes] of weekly) {
      if (minutes > WEEKLY_CAP_MINUTES) {
        throw new Error(`employee ${employeeId} week ${week} has ${minutes} > cap`);
      }
    }
  }
}
