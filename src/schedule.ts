import { parseDate, weekdayOf } from "./date";
import { LocalMode, localToUtc } from "./timezone";
import type { ScheduleInput } from "./types";

/** 编译后的排期：全部转为数值形式，便于快速检查。 */
export interface CompiledSchedule {
  id: string;
  pickupPointId: string;
  skuIds: string[];
  skuSet: ReadonlySet<string>;
  validFromDay: number;
  validToDay: number;
  /** 锚点周一所在周的周序号（2008-01-07 所在周为第 0 周）。 */
  anchorWeek: number;
  intervalWeeks: number;
  /** 星期几位掩码，bit0=周一 … bit6=周日。 */
  weekdayMask: number;
  openMinute: number;
  closeMinute: number;
  closeNextDay: boolean;
  excludedDays: ReadonlySet<number>;
  /** 开放日为周日时窗口是否触及当日 01:00-03:00（DST 敏感）。 */
  sensitiveSunday: boolean;
  /** 开放日为周六时窗口是否触及次日（周日）01:00-03:00。 */
  sensitiveSaturday: boolean;
}

const MAX_SKUS = 8;
const MAX_EXCLUSIONS = 64;
const MINUTES_PER_DAY = 1440;

function fail(message: string): never {
  throw new Error(`invalid schedule: ${message}`);
}

/** 校验并编译一条排期；非法输入抛出错误。 */
export function compileSchedule(input: ScheduleInput): CompiledSchedule {
  if (!input.id) fail("id is required");
  if (!input.pickupPointId) fail("pickupPointId is required");
  if (!Array.isArray(input.skuIds) || input.skuIds.length > MAX_SKUS) {
    fail(`skuIds must contain at most ${MAX_SKUS} entries`);
  }
  for (const sku of input.skuIds) {
    if (!sku) fail("skuIds entries must be non-empty");
  }
  const validFromDay = parseDate(input.validFrom);
  const validToDay = parseDate(input.validTo);
  if (validFromDay > validToDay) fail("validFrom must not be after validTo");
  const anchorDay = parseDate(input.anchorMonday);
  if (weekdayOf(anchorDay) !== 0) fail("anchorMonday must be a Monday");
  const anchorWeek = Math.floor((anchorDay - 6) / 7);
  if (
    !Number.isInteger(input.intervalWeeks) ||
    input.intervalWeeks < 1 ||
    input.intervalWeeks > 52
  ) {
    fail("intervalWeeks must be an integer between 1 and 52");
  }
  if (!Array.isArray(input.weekdays) || input.weekdays.length === 0) {
    fail("weekdays must be a non-empty array");
  }
  let weekdayMask = 0;
  for (const d of input.weekdays) {
    if (!Number.isInteger(d) || d < 1 || d > 7) {
      fail("weekdays entries must be integers between 1 (Mon) and 7 (Sun)");
    }
    weekdayMask |= 1 << (d - 1);
  }
  const { openMinute, closeMinute, closeNextDay } = input;
  if (!Number.isInteger(openMinute) || openMinute < 0 || openMinute >= MINUTES_PER_DAY) {
    fail("openMinute must be an integer between 0 and 1439");
  }
  if (!Number.isInteger(closeMinute) || closeMinute < 0 || closeMinute >= MINUTES_PER_DAY) {
    fail("closeMinute must be an integer between 0 and 1439");
  }
  if (!closeNextDay && closeMinute <= openMinute) {
    fail("closeMinute must be later than openMinute on the same day");
  }
  if (!Array.isArray(input.excludedDates) || input.excludedDates.length > MAX_EXCLUSIONS) {
    fail(`excludedDates must contain at most ${MAX_EXCLUSIONS} entries`);
  }
  const excludedDays = new Set<number>();
  for (const text of input.excludedDates) {
    excludedDays.add(parseDate(text));
  }
  // 窗口相对开放日的本地分钟跨度。
  const spanStart = openMinute;
  const spanEnd = closeMinute + (closeNextDay ? MINUTES_PER_DAY : 0);
  // 周日 01:00-03:00 为 DST 过渡区（含端点处的模糊/缺失时刻）。
  const sensitiveSunday = spanStart < 180 && spanEnd >= 60;
  const sensitiveSaturday =
    closeNextDay && spanEnd >= MINUTES_PER_DAY + 60;
  return {
    id: input.id,
    pickupPointId: input.pickupPointId,
    skuIds: [...input.skuIds],
    skuSet: new Set(input.skuIds),
    validFromDay,
    validToDay,
    anchorWeek,
    intervalWeeks: input.intervalWeeks,
    weekdayMask,
    openMinute,
    closeMinute,
    closeNextDay,
    excludedDays,
    sensitiveSunday,
    sensitiveSaturday,
  };
}

/**
 * 计算某开放日期对应场次的真实时间窗口 [openUtc, closeUtc)（UTC 分钟）。
 * 被排除或开放/截止落入春季缺失时刻时返回 null。
 */
export function sessionWindow(
  schedule: CompiledSchedule,
  openDay: number,
): { openUtc: number; closeUtc: number } | null {
  if (schedule.excludedDays.has(openDay)) return null;
  const openUtc = localToUtc(openDay, schedule.openMinute, LocalMode.Open);
  if (openUtc === null) return null;
  const closeDay = schedule.closeNextDay ? openDay + 1 : openDay;
  const closeUtc = localToUtc(closeDay, schedule.closeMinute, LocalMode.Close);
  if (closeUtc === null) return null;
  return { openUtc, closeUtc };
}
