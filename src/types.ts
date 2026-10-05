/** 本地时间：同一薪资时区内的日期（YYYY-MM-DD）与当日整分钟（0..1439），忽略夏令时。 */
export interface LocalTime {
  date: string;
  minute: number;
}

/** 一条工时记录。 */
export interface ShiftRecord {
  employeeId: string;
  siteId: string;
  jobId: string;
  start: LocalTime;
  end: LocalTime;
  /** 基础时薪，整数分。 */
  baseRateCents: number;
  /** 班次差异，整数基点（100 基点 = 1%）。 */
  shiftDiffBps: number;
}

/** 某工地与工种组合的最低时薪。 */
export interface MinimumRate {
  siteId: string;
  jobId: string;
  rateCents: number;
}

/** 核算规则。 */
export interface PayRules {
  minimumRates: MinimumRate[];
  dailyOvertimeEnabled: boolean;
}

/** 账行：以员工、工作周、工地、工种为唯一键。 */
export interface PayLine {
  employeeId: string;
  /** 0 或 1，表示本期内第几周。 */
  weekIndex: number;
  /** 该周周一日期（YYYY-MM-DD）。 */
  weekStart: string;
  siteId: string;
  jobId: string;
  regularMinutes: number;
  dailyOvertimeMinutes: number;
  weeklyOvertimeMinutes: number;
  /** 基础工资，整数分（已按周舍入并分币）。 */
  basePayCents: number;
  /** 加班增额，整数分（已按周舍入并分币）。 */
  overtimePremiumCents: number;
}

/** 员工本期合计。 */
export interface EmployeeTotal {
  employeeId: string;
  regularMinutes: number;
  dailyOvertimeMinutes: number;
  weeklyOvertimeMinutes: number;
  basePayCents: number;
  overtimePremiumCents: number;
}

/** calculatePayRun 的返回结果。 */
export interface PayRunResult {
  lines: PayLine[];
  totals: EmployeeTotal[];
}
