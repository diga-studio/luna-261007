/** 一条排期的输入定义（已发布或待发布）。 */
export interface ScheduleInput {
  /** 排期唯一标识。 */
  id: string;
  /** 取货点标识。 */
  pickupPointId: string;
  /** 售卖的 SKU 列表，最多 8 个。 */
  skuIds: string[];
  /** 有效期起始日期（含），YYYY-MM-DD，支持 2008-01-01 至 9999-12-31。 */
  validFrom: string;
  /** 有效期截止日期（含），YYYY-MM-DD。 */
  validTo: string;
  /** 作为锚点的某个周一，YYYY-MM-DD。 */
  anchorMonday: string;
  /** 重复间隔周数 N，1 至 52。 */
  intervalWeeks: number;
  /** 每周内生成场次的星期几集合，1=周一 … 7=周日。 */
  weekdays: number[];
  /** 本地开放时间，距当日零点分钟数，0-1439。 */
  openMinute: number;
  /** 本地截止时间，距当日零点分钟数，0-1439。 */
  closeMinute: number;
  /** 截止是否在开放次日；同日时 closeMinute 必须晚于 openMinute。 */
  closeNextDay: boolean;
  /** 排除日期（取消当日原本会开启的场次），YYYY-MM-DD，最多 64 个。 */
  excludedDates: string[];
}

/** 冲突详情：双方某一对场次的相交信息。 */
export interface ConflictDetail {
  /** 全有效期内最早的相交瞬间（UTC，ISO 8601）。 */
  earliestInstantUtc: string;
  /** 命中的既有排期 id。 */
  existingScheduleId: string;
  /** 一个共享的 SKU。 */
  sharedSku: string;
  /** 待发布排期冲突场次的开放日期，YYYY-MM-DD。 */
  candidateOpenDate: string;
  /** 既有排期冲突场次的开放日期，YYYY-MM-DD。 */
  existingOpenDate: string;
}

export type CheckResult =
  | { ok: true }
  | ({ ok: false } & ConflictDetail);
