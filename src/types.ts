/** 单日漏斗计数。 */
export interface DayCount {
  captured: number;
  converted: number;
}

/** report 返回的按日条目。 */
export interface ReportEntry extends DayCount {
  day: number;
}
