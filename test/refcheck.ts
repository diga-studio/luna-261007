// 独立逐场核对实现：直接枚举每条排期在有效期内的全部场次，
// 再对场次做笛卡尔积求相交。仅用于短有效期的正确性对照。
import { parseDate, weekdayOf } from "../src/date";
import { LocalMode, localToUtc } from "../src/timezone";
import type { ScheduleInput } from "../src/types";

export interface RefSession {
  openUtc: number;
  closeUtc: number;
  openDay: number;
}

export function enumerateSessions(input: ScheduleInput): RefSession[] {
  const from = parseDate(input.validFrom);
  const to = parseDate(input.validTo);
  const anchorWeek = Math.floor((parseDate(input.anchorMonday) - 6) / 7);
  const excluded = new Set(input.excludedDates.map((t) => parseDate(t)));
  const weekdays = new Set(input.weekdays.map((d) => d - 1));
  const sessions: RefSession[] = [];
  for (let d = from; d <= to; d++) {
    if (!weekdays.has(weekdayOf(d))) continue;
    const w = Math.floor((d - 6) / 7);
    if (w < anchorWeek || (w - anchorWeek) % input.intervalWeeks !== 0) continue;
    if (excluded.has(d)) continue;
    const openUtc = localToUtc(d, input.openMinute, LocalMode.Open);
    if (openUtc === null) continue;
    const closeUtc = localToUtc(
      input.closeNextDay ? d + 1 : d,
      input.closeMinute,
      LocalMode.Close,
    );
    if (closeUtc === null) continue;
    sessions.push({ openUtc, closeUtc, openDay: d });
  }
  return sessions;
}

export interface RefConflict {
  instantUtc: number;
  existingId: string;
  sharedSku: string;
  candidateOpenDay: number;
  existingOpenDay: number;
}

export function bruteCheck(
  candidate: ScheduleInput,
  published: ScheduleInput[],
): RefConflict | null {
  const candSessions = enumerateSessions(candidate);
  let best: RefConflict | null = null;
  for (const pub of published) {
    if (pub.pickupPointId !== candidate.pickupPointId) continue;
    const shared = candidate.skuIds.find((s) => pub.skuIds.includes(s));
    if (shared === undefined) continue;
    const pubSessions = enumerateSessions(pub);
    for (const cs of candSessions) {
      for (const ps of pubSessions) {
        const start = Math.max(cs.openUtc, ps.openUtc);
        if (start < Math.min(cs.closeUtc, ps.closeUtc)) {
          if (!best || start < best.instantUtc) {
            best = {
              instantUtc: start,
              existingId: pub.id,
              sharedSku: shared,
              candidateOpenDay: cs.openDay,
              existingOpenDay: ps.openDay,
            };
          }
        }
      }
    }
  }
  return best;
}

/** 确定性伪随机数（mulberry32）。 */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
