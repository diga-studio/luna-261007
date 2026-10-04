/** UTC 日序号，由调用者换算好。 */
export type Day = number;
/** 渠道标识。 */
export type FlowId = string;
/** 线索标识，全局唯一，永久有效。 */
export type LeadId = string | number;

/** 单日的漏斗计数。 */
export interface DayCounts {
  captured: number;
  converted: number;
}

/** report 返回的单日条目（仅包含有贡献的日期，缺失日期视为零）。 */
export interface DayEntry extends DayCounts {
  day: Day;
}

/** report 的返回结构：闭区间内的逐日非零条目 + 区间合计。 */
export interface FunnelReport {
  flowId: FlowId;
  fromDay: Day;
  toDay: Day;
  days: DayEntry[];
  totalCaptured: number;
  totalConverted: number;
}
