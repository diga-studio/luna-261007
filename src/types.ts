/** 一条待装入/待检查的排期（输入形式）。 */
export interface ScheduleInput {
  /** 排期唯一标识。 */
  id: string;
  /** 取货点标识。 */
  pickupPointId: string;
  /** 售卖的 SKU，1 至 8 个。 */
  skus: string[];
  /** 有效期起始日期（含），格式 YYYY-MM-DD，2008..9999 年。 */
  validFrom: string;
  /** 有效期截止日期（含），格式 YYYY-MM-DD，2008..9999 年。 */
  validTo: string;
  /** 作为锚点的某个周一，格式 YYYY-MM-DD。 */
  anchorMonday: string;
  /** 重复间隔周数 N，1..52。 */
  intervalWeeks: number;
  /** 每周内生成场次的星期几集合，0=周一 .. 6=周日。 */
  weekdays: number[];
  /** 本地开放时间，格式 HH:MM（24 小时制）。 */
  openTime: string;
  /** 本地截止时间，格式 HH:MM。 */
  closeTime: string;
  /** 截止是否在开放次日；false 时 closeTime 必须晚于 openTime。 */
  closeNextDay: boolean;
  /** 排除日期（取消这些日期原本会开启的场次），最多 64 个。 */
  excludedDates?: string[];
}

/** 检查命中冲突时的详细信息。 */
export interface ConflictInfo {
  /** 全有效期内最早的相交瞬间（Unix 分钟，UTC）。 */
  earliestOverlapStartMinutesUtc: number;
  /** 同一瞬间的 ISO 8601 表示（UTC）。 */
  earliestOverlapStartIsoUtc: string;
  /** 命中的既有排期 id。 */
  existingScheduleId: string;
  /** 一个共享 SKU。 */
  sharedSku: string;
  /** 待发布排期冲突场次的开放日期（YYYY-MM-DD，本地）。 */
  pendingOpenDate: string;
  /** 既有排期冲突场次的开放日期（YYYY-MM-DD，本地）。 */
  existingOpenDate: string;
}

export interface CheckResult {
  canPublish: boolean;
  conflict?: ConflictInfo;
}
