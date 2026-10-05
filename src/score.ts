import { buildEvidence } from "./evidence.js";
import { maxWeightAssignment } from "./matching.js";
import { windowMonths } from "./months.js";
import type { Job, MatchResult, Month, MonthAllocation, ResumeEntry } from "./types.js";

/** Months in the scoring window, baseline month included. */
export const WINDOW_MONTHS = 60;
/** Most recent months (baseline included) worth 2 points. */
export const RECENT_MONTHS = 12;

/**
 * Score one candidate's resume against one job as of `baselineMonth`.
 * Only the most recent WINDOW_MONTHS natural months including the
 * baseline are considered. Returns the maximum score over all legal
 * month allocations plus an explaining allocation.
 */
export function scoreResume(
  job: Job,
  entries: ResumeEntry[],
  baselineMonth: Month,
): MatchResult {
  const requirements = job.requirements;
  const denominator =
    2 * requirements.reduce((sum, req) => sum + req.targetMonths * req.weight, 0);

  const window = windowMonths(baselineMonth, WINDOW_MONTHS);
  const points = window.map((_, index) =>
    index >= WINDOW_MONTHS - RECENT_MONTHS ? 2 : 1,
  );
  const evidence = buildEvidence(entries, window);

  const values = window.map((month, i) =>
    requirements.map((req) =>
      evidence.get(month)!.has(req.skill) ? points[i] * req.weight : 0,
    ),
  );
  const assignment = maxWeightAssignment(
    values,
    requirements.map((req) => req.targetMonths),
  );

  const allocations: MonthAllocation[] = [];
  for (let i = 0; i < window.length; i++) {
    const j = assignment[i];
    if (j < 0) continue;
    allocations.push({
      month: window[i],
      skill: requirements[j].skill,
      points: points[i],
      weightedScore: values[i][j],
    });
  }

  const numerator = allocations.reduce((sum, a) => sum + a.weightedScore, 0);
  const score = denominator > 0 ? (100 * numerator) / denominator : 0;
  return { score, numerator, denominator, allocations };
}
