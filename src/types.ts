/** Readiness level: 0 = now, 1 = within one year, 2 = two years or later. */
export type Readiness = 0 | 1 | 2;

export interface SkillRequirement {
  /** Skill key, matched against employee skill profile keys. */
  skill: string;
  /** Required proficiency, integer 1..5. */
  required: number;
  /** Weight of this requirement, integer 1..100. */
  weight: number;
}

export interface Job {
  id: string;
  /** At least one requirement per job. */
  requirements: SkillRequirement[];
}

export interface Employee {
  id: string;
  /** Skill key -> actual proficiency, integer 0..5. Missing skills count as 0. */
  skills: Record<string, number>;
}

export interface CandidateEntry {
  jobId: string;
  employeeId: string;
  readiness: Readiness;
}

export interface SuccessionModel {
  jobs: Job[];
  employees: Employee[];
  candidates: CandidateEntry[];
}

export interface Reservation {
  jobId: string;
  employeeId: string;
  readiness: Readiness;
  /** Skill gap in basis points (0..10000). */
  gap: number;
}

export interface PlanMetrics {
  /** Number of reservations with readiness 0. */
  c0: number;
  /** Number of reservations with readiness 0 or 1. */
  c1: number;
  /** Total number of reservations. */
  c2: number;
  /** Maximum gap among chosen pairs; 0 for an empty plan. */
  maxGap: number;
  /** Sum of gaps over chosen pairs; 0 for an empty plan. */
  totalGap: number;
}

export interface SuccessionPlan {
  reservations: Reservation[];
  metrics: PlanMetrics;
}
