import type { Month, ResumeEntry } from "./types.js";

/**
 * Build, for each month in `window`, the set of skills provable in that
 * month: the union of skills of every entry covering the month.
 * Overlapping or duplicate entries never add extra evidence.
 */
export function buildEvidence(
  entries: ResumeEntry[],
  window: Month[],
): Map<Month, Set<string>> {
  const evidence = new Map<Month, Set<string>>();
  for (const month of window) {
    evidence.set(month, new Set());
  }
  for (const entry of entries) {
    const skills = new Set(entry.skills);
    for (const month of window) {
      if (month < entry.startMonth || month > entry.endMonth) continue;
      const bucket = evidence.get(month)!;
      for (const skill of skills) {
        bucket.add(skill);
      }
    }
  }
  return evidence;
}
