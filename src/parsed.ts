/** 已解析排期：把字符串输入编译为整数运算友好的内部形式。 */
import { daysFromCivil, civilFromDays, weekdayOf } from "./calendar.js";
import type { ScheduleInput } from "./types.js";

export interface ParsedSchedule {
  readonly id: string;
  readonly pickupPointId: string;
  readonly skus: readonly string[];
  readonly skuSet: ReadonlySet<string>;
  /** 有效期 [from, to]，序列日，含端点。 */
  readonly validFrom: number;
  readonly validTo: number;
  /** 锚点周一序列日。 */
  readonly anchor: number;
  /** 重复间隔周数 1..52。 */
  readonly intervalWeeks: number;
  /** 步长（天）= 7 * intervalWeeks。 */
  readonly stepDays: number;
  /** 升序去重后的星期几（0=周一..6=周日）。 */
  readonly weekdays: readonly number[];
  /** 每个选定星期几的首个场次开放日（锚点周内的序列日），与 weekdays 对齐。 */
  readonly weekdayFirst: readonly number[];
  /** 开放时间（当日分钟）。 */
  readonly openMin: number;
  /** 截止时间（开放日当日分钟）。 */
  readonly closeMin: number;
  /** 截止是否在次日。 */
  readonly closeNextDay: boolean;
  /** 排除日期序列日集合。 */
  readonly excluded: ReadonlySet<number>;
}

const MIN_YEAR = 2008;
const MAX_YEAR = 9999;
const MAX_SKUS = 8;
const MAX_EXCLUSIONS = 64;

function fail(message: string): never {
  throw new Error(`invalid schedule: ${message}`);
}

/** 解析 YYYY-MM-DD 为序列日，校验年份范围与日期真实性。 */
export function parseDate(value: string, field: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) fail(`${field} 不是 YYYY-MM-DD 格式: ${value}`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < MIN_YEAR || y > MAX_YEAR) fail(`${field} 年份超出 ${MIN_YEAR}..${MAX_YEAR}: ${value}`);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) fail(`${field} 非法日期: ${value}`);
  const serial = daysFromCivil(y, mo, d);
  const [ry, rm, rd] = civilFromDays(serial);
  if (ry !== y || rm !== mo || rd !== d) fail(`${field} 非法日期: ${value}`);
  return serial;
}

/** 解析 HH:MM 为当日分钟。 */
export function parseTime(value: string, field: string): number {
  const m = /^(\d{2}):(\d{2})$/.exec(value);
  if (!m) fail(`${field} 不是 HH:MM 格式: ${value}`);
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh > 23 || mm > 59) fail(`${field} 非法时间: ${value}`);
  return hh * 60 + mm;
}

/** 解析并校验输入；非法输入抛出 Error。 */
export function parseSchedule(input: ScheduleInput): ParsedSchedule {
  if (!input || typeof input !== "object") fail("输入不是对象");
  const { id, pickupPointId } = input;
  if (!id) fail("缺少 id");
  if (!pickupPointId) fail(`排期 ${id}: 缺少 pickupPointId`);

  const skus = input.skus;
  if (!Array.isArray(skus) || skus.length < 1 || skus.length > MAX_SKUS) {
    fail(`排期 ${id}: SKU 数量须为 1..${MAX_SKUS}`);
  }
  const skuSet = new Set<string>();
  for (const sku of skus) {
    if (typeof sku !== "string" || sku.length === 0) fail(`排期 ${id}: 非法 SKU`);
    skuSet.add(sku);
  }

  const validFrom = parseDate(input.validFrom, `排期 ${id} validFrom`);
  const validTo = parseDate(input.validTo, `排期 ${id} validTo`);
  if (validFrom > validTo) fail(`排期 ${id}: 有效期起止颠倒`);

  const anchor = parseDate(input.anchorMonday, `排期 ${id} anchorMonday`);
  if (weekdayOf(anchor) !== 0) fail(`排期 ${id}: anchorMonday 必须是周一`);

  const n = input.intervalWeeks;
  if (!Number.isInteger(n) || n < 1 || n > 52) fail(`排期 ${id}: intervalWeeks 须为 1..52 整数`);

  if (!Array.isArray(input.weekdays) || input.weekdays.length < 1) {
    fail(`排期 ${id}: weekdays 不能为空`);
  }
  const weekdays = [...new Set(input.weekdays)].sort((a, b) => a - b);
  for (const w of weekdays) {
    if (!Number.isInteger(w) || w < 0 || w > 6) fail(`排期 ${id}: 非法星期几 ${w}`);
  }

  const openMin = parseTime(input.openTime, `排期 ${id} openTime`);
  const closeMin = parseTime(input.closeTime, `排期 ${id} closeTime`);
  const closeNextDay = input.closeNextDay === true;
  if (!closeNextDay && closeMin <= openMin) {
    fail(`排期 ${id}: 同日截止必须晚于开放`);
  }

  const excludedList = input.excludedDates ?? [];
  if (excludedList.length > MAX_EXCLUSIONS) {
    fail(`排期 ${id}: 排除日期超过 ${MAX_EXCLUSIONS} 个`);
  }
  const excluded = new Set<number>();
  for (const e of excludedList) {
    excluded.add(parseDate(e, `排期 ${id} excludedDates`));
  }

  return {
    id,
    pickupPointId,
    skus: [...skuSet],
    skuSet,
    validFrom,
    validTo,
    anchor,
    intervalWeeks: n,
    stepDays: n * 7,
    weekdays,
    weekdayFirst: weekdays.map((w) => anchor + w),
    openMin,
    closeMin,
    closeNextDay,
    excluded,
  };
}
