import type { Job, ResumeEntry, ScoreResult } from "./types.js";
import { parseMonth, formatMonth } from "./months.js";
import { buildEvidence } from "./evidence.js";
import { optimalAssignment, type AssignmentMonth } from "./optimize.js";

/** 评分窗口长度（自然月）。 */
const WINDOW_MONTHS = 60;
/** 窗口内贡献 2 点的最近月数。 */
const RECENT_MONTHS = 12;

/**
 * 对单个候选人针对一个岗位评分。
 *
 * @param job 岗位（技能要求互不重复）。
 * @param entries 候选人履历。
 * @param baselineMonth 基准月份 "YYYY-MM"；只使用含该月在内的最近 60 个自然月。
 */
export function scoreCandidate(
  job: Job,
  entries: ResumeEntry[],
  baselineMonth: string,
): ScoreResult {
  const skillIndexByName = new Map<string, number>();
  job.requirements.forEach((requirement, index) => {
    if (skillIndexByName.has(requirement.skill)) {
      throw new Error(`duplicate skill requirement: ${requirement.skill}`);
    }
    skillIndexByName.set(requirement.skill, index);
  });

  const denominator = 2 * job.requirements.reduce(
    (sum, requirement) => sum + requirement.targetMonths * requirement.weight,
    0,
  );
  if (denominator === 0) {
    return { score: 0, numerator: 0, denominator: 0, allocations: [] };
  }

  const baseline = parseMonth(baselineMonth);
  const windowStart = baseline - (WINDOW_MONTHS - 1);
  const recentStart = baseline - (RECENT_MONTHS - 1);

  const evidence = buildEvidence(entries, windowStart, baseline);

  // 只保留岗位要求的技能；月份按序号升序，保证输出确定。
  const months: AssignmentMonth[] = [];
  for (const [monthIndex, skills] of [...evidence.entries()].sort((a, b) => a[0] - b[0])) {
    const skillOptions: number[] = [];
    for (const skill of skills) {
      const index = skillIndexByName.get(skill);
      if (index !== undefined) skillOptions.push(index);
    }
    if (skillOptions.length === 0) continue;
    skillOptions.sort((a, b) => a - b);
    months.push({
      monthIndex,
      skillOptions,
      points: monthIndex >= recentStart ? 2 : 1,
    });
  }

  const capacities = job.requirements.map((requirement) => requirement.targetMonths);
  const weights = job.requirements.map((requirement) => requirement.weight);
  const assignment = optimalAssignment(months, capacities, weights);

  const allocations = assignment
    .map(({ monthPos, skillIndex }) => {
      const month = months[monthPos]!;
      const weight = weights[skillIndex]!;
      return {
        month: formatMonth(month.monthIndex),
        skill: job.requirements[skillIndex]!.skill,
        points: month.points,
        weightedScore: month.points * weight,
      };
    })
    .sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0));

  const numerator = allocations.reduce((sum, allocation) => sum + allocation.weightedScore, 0);
  return {
    score: (100 * numerator) / denominator,
    numerator,
    denominator,
    allocations,
  };
}
