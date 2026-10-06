/** 独立逐场枚举的核对实现：只用于测试，不追求效率。 */
import { localToUtcMinutes, LocalKind } from "../src/calendar.js";
import { parseSchedule } from "../src/parsed.js";
import type { ScheduleInput } from "../src/types.js";

export interface BruteSession {
  openDay: number;
  openUtc: number;
  closeUtc: number;
}

/** 逐周逐日枚举一条排期的全部场次窗口（短有效期场景）。 */
export function enumerateSessions(input: ScheduleInput): BruteSession[] {
  const s = parseSchedule(input);
  const sessions: BruteSession[] = [];
  for (const w of s.weekdays) {
    const first = s.anchor + w;
    for (let day = first; day <= s.validTo; day += s.stepDays) {
      if (day < s.validFrom) continue;
      if (s.excluded.has(day)) continue;
      const open = localToUtcMinutes(day, s.openMin, LocalKind.Open);
      if (open === null) continue;
      const closeDay = day + (s.closeNextDay ? 1 : 0);
      const close = localToUtcMinutes(closeDay, s.closeMin, LocalKind.Close);
      if (close === null) continue;
      sessions.push({ openDay: day, openUtc: open, closeUtc: close });
    }
  }
  return sessions;
}

export interface BruteConflict {
  instant: number;
  openDayA: number;
  openDayB: number;
}

/** 逐场两两比较，求两条排期的最早相交瞬间。 */
export function bruteForceConflict(
  a: ScheduleInput,
  b: ScheduleInput,
): BruteConflict | null {
  const sa = enumerateSessions(a);
  const sb = enumerateSessions(b);
  let best: BruteConflict | null = null;
  for (const x of sa) {
    for (const y of sb) {
      if (x.openUtc < y.closeUtc && y.openUtc < x.closeUtc) {
        const instant = Math.max(x.openUtc, y.openUtc);
        if (best === null || instant < best.instant) {
          best = { instant, openDayA: x.openDay, openDayB: y.openDay };
        }
      }
    }
  }
  return best;
}
