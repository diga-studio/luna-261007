import type { ResumeEntry } from "./types.js";
import { parseMonth, monthRange } from "./months.js";

/**
 * 汇总履历证据：对每个有效月份，给出覆盖该月的所有履历技能的并集。
 * 重叠履历、重复记录、重复技能不会增加该月证据。
 *
 * @param entries 履历列表（可重叠、可重复）。
 * @param windowStart 窗口起始月份序号（含）。
 * @param windowEnd 窗口结束月份序号（含，即基准月份）。
 * @returns 月份序号 -> 该月可证明的技能集合，仅包含有证据的月份。
 */
export function buildEvidence(
  entries: ResumeEntry[],
  windowStart: number,
  windowEnd: number,
): Map<number, Set<string>> {
  const evidence = new Map<number, Set<string>>();
  for (const entry of entries) {
    const start = Math.max(parseMonth(entry.startMonth), windowStart);
    const end = Math.min(parseMonth(entry.endMonth), windowEnd);
    // Set 语义保证重叠履历、重复记录、重复技能不会增加该月证据。
    const skills = new Set(entry.skills);
    for (const monthIndex of monthRange(start, end)) {
      let bucket = evidence.get(monthIndex);
      if (!bucket) {
        bucket = new Set<string>();
        evidence.set(monthIndex, bucket);
      }
      for (const skill of skills) {
        bucket.add(skill);
      }
    }
  }
  return evidence;
}
