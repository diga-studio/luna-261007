/** A local calendar date in the pay timezone, e.g. "2026-10-05". DST is ignored. */
export type LocalDate = string;

/** A local wall-clock time: a date plus whole minutes after midnight (0..1439). */
export interface LocalDateTime {
  date: LocalDate;
  minute: number;
}

/** One raw work record. Records of one employee never overlap; they may cross midnight or week boundaries. */
export interface ShiftRecord {
  employeeId: string;
  siteId: string;
  jobId: string;
  start: LocalDateTime;
  end: LocalDateTime;
  /** Base hourly rate in integer cents. */
  baseRateCents: number;
  /** Shift differential in integer basis points (100 bps = 1%). */
  shiftDiffBps: number;
}

/** Minimum hourly rate for a site/job pair, in integer cents. */
export interface MinimumRate {
  siteId: string;
  jobId: string;
  rateCents: number;
}

export interface PayRules {
  minimumRates: MinimumRate[];
  /** When true, minutes past 480 per calendar day become daily OT and never count toward weekly OT. */
  dailyOvertimeEnabled: boolean;
}

export interface PayLine {
  employeeId: string;
  /** 0-based week index inside this pay run. */
  weekIndex: number;
  /** Local date of the week's Monday. */
  weekStart: LocalDate;
  siteId: string;
  jobId: string;
  regularMinutes: number;
  dailyOtMinutes: number;
  weeklyOtMinutes: number;
  basePayCents: number;
  overtimePremiumCents: number;
}

export interface EmployeeTotal {
  employeeId: string;
  regularMinutes: number;
  dailyOtMinutes: number;
  weeklyOtMinutes: number;
  basePayCents: number;
  overtimePremiumCents: number;
  totalCents: number;
}

export interface PayRunResult {
  lines: PayLine[];
  employeeTotals: EmployeeTotal[];
}
