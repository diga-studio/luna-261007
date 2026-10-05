/**
 * A calendar month in "YYYY-MM" form. Callers normalize skill names;
 * matching is exact string equality.
 */
export type Month = string;

/** One requirement of a job. Skills within a job never repeat. */
export interface SkillRequirement {
  skill: string;
  /** Target months of experience for this skill. */
  targetMonths: number;
  /** Weight of this skill in the weighted score. */
  weight: number;
}

export interface Job {
  requirements: SkillRequirement[];
}

/**
 * One resume entry. Both startMonth and endMonth are inclusive.
 * Entries may overlap or repeat; overlapping evidence never
 * double-counts a month.
 */
export interface ResumeEntry {
  startMonth: Month;
  endMonth: Month;
  skills: string[];
}

/** One allocated month in the explanation of a score. */
export interface MonthAllocation {
  month: Month;
  skill: string;
  /** 2 for the most recent 12 months (baseline included), else 1. */
  points: number;
  /** points * weight of the allocated skill. */
  weightedScore: number;
}

export interface MatchResult {
  /** 100 * numerator / denominator, the best score over all legal allocations. */
  score: number;
  /** Sum of weightedScore over allocations. */
  numerator: number;
  /** 2 * sum(targetMonths * weight) over requirements. */
  denominator: number;
  /** Per-month allocation explaining the score. */
  allocations: MonthAllocation[];
}
