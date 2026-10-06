import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDate } from "../src/date";
import { LocalMode, formatUtcInstant, localToUtc } from "../src/timezone";

function utc(date: string, minute: number, mode: LocalMode): number | null {
  return localToUtc(parseDate(date), minute, mode);
}

test("标准时间 UTC-6", () => {
  // 2024-01-15 00:00 本地 = 06:00Z
  const t = utc("2024-01-15", 0, LocalMode.Open)!;
  assert.equal(formatUtcInstant(t), "2024-01-15T06:00:00Z");
  const t2 = utc("2024-01-15", 600, LocalMode.Open)!; // 10:00
  assert.equal(formatUtcInstant(t2), "2024-01-15T16:00:00Z");
});

test("夏令时 UTC-5", () => {
  const t = utc("2024-07-01", 600, LocalMode.Open)!; // 10:00 CDT
  assert.equal(formatUtcInstant(t), "2024-07-01T15:00:00Z");
});

test("春季缺失时刻返回 null", () => {
  // 2024-03-10 02:00-03:00 不存在
  assert.equal(utc("2024-03-10", 120, LocalMode.Open), null);
  assert.equal(utc("2024-03-10", 179, LocalMode.Close), null);
  // 01:59 存在（CST），03:00 存在（CDT）
  assert.equal(formatUtcInstant(utc("2024-03-10", 119, LocalMode.Open)!), "2024-03-10T07:59:00Z");
  assert.equal(formatUtcInstant(utc("2024-03-10", 180, LocalMode.Open)!), "2024-03-10T08:00:00Z");
});

test("秋季重复时刻开放取较早、截止取较晚", () => {
  // 2024-11-03 01:30 出现两次：CDT 06:30Z（较早）与 CST 07:30Z（较晚）
  assert.equal(formatUtcInstant(utc("2024-11-03", 90, LocalMode.Open)!), "2024-11-03T06:30:00Z");
  assert.equal(formatUtcInstant(utc("2024-11-03", 90, LocalMode.Close)!), "2024-11-03T07:30:00Z");
  // 00:59 只出现一次（CDT）；02:00 只出现一次（CST）
  assert.equal(formatUtcInstant(utc("2024-11-03", 59, LocalMode.Open)!), "2024-11-03T05:59:00Z");
  assert.equal(formatUtcInstant(utc("2024-11-03", 120, LocalMode.Open)!), "2024-11-03T08:00:00Z");
});

test("过渡日之外的周日不受影响", () => {
  // 普通 3 月周日（非第二个）仍是 CST
  assert.equal(formatUtcInstant(utc("2024-03-03", 120, LocalMode.Open)!), "2024-03-03T08:00:00Z");
});
