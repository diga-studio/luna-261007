import type { SkillRequirement } from "./types";

/**
 * Skill gap in basis points (0..10000):
 *   floor(10000 * sum(max(required - actual, 0) * weight) / sum(required * weight))
 * Missing skills count as actual = 0. Requirements are guaranteed non-empty.
 */
export function computeGap(
  requirements: SkillRequirement[],
  skills: Record<string, number>
): number {
  let weightedGap = 0;
  let weightedRequired = 0;
  for (const req of requirements) {
    const actual = skills[req.skill] ?? 0;
    weightedGap += Math.max(req.required - actual, 0) * req.weight;
    weightedRequired += req.required * req.weight;
  }
  return Math.floor((10000 * weightedGap) / weightedRequired);
}
