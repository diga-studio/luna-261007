import test from "node:test";
import assert from "node:assert/strict";
import { normalizeDate } from "../src/date.js";

test("UTC 标记输入规范化为固定 3 位小数秒", () => {
  assert.equal(normalizeDate("2024-03-01T12:00:00Z"), "2024-03-01T12:00:00.000Z");
  assert.equal(normalizeDate("2024-03-01T12:00:00.5Z"), "2024-03-01T12:00:00.500Z");
  assert.equal(normalizeDate("2024-03-01T12:00:00.05Z"), "2024-03-01T12:00:00.050Z");
  assert.equal(normalizeDate("2024-03-01T12:00:00.123Z"), "2024-03-01T12:00:00.123Z");
});

test("跨日期的时区偏移换算", () => {
  // 东八区零点过后 -> 前一天 UTC
  assert.equal(normalizeDate("2024-01-01T00:30:00+08:00"), "2023-12-31T16:30:00.000Z");
  // 负偏移跨日 -> 次日 UTC
  assert.equal(normalizeDate("2023-12-31T23:00:00-02:00"), "2024-01-01T01:00:00.000Z");
  // 跨月与跨年
  assert.equal(normalizeDate("2024-03-01T00:00:00+05:30"), "2024-02-29T18:30:00.000Z");
  assert.equal(normalizeDate("2024-01-01T00:00:00+13:00"), "2023-12-31T11:00:00.000Z");
  // 偏移带分钟
  assert.equal(normalizeDate("2024-06-15T12:00:00+05:45"), "2024-06-15T06:15:00.000Z");
});

test("非法日历日期失败，不自动进位", () => {
  assert.equal(normalizeDate("2023-02-29T00:00:00Z"), null); // 非闰年
  assert.equal(normalizeDate("2024-02-30T00:00:00Z"), null);
  assert.equal(normalizeDate("2024-04-31T00:00:00Z"), null);
  assert.equal(normalizeDate("2024-13-01T00:00:00Z"), null);
  assert.equal(normalizeDate("2024-00-10T00:00:00Z"), null);
  assert.equal(normalizeDate("2024-01-00T00:00:00Z"), null);
  assert.equal(normalizeDate("2000-02-29T00:00:00Z"), "2000-02-29T00:00:00.000Z"); // 400 年闰
  assert.equal(normalizeDate("1900-02-29T00:00:00Z"), null); // 100 年不闰
});

test("闰秒与非法时分秒失败", () => {
  assert.equal(normalizeDate("2016-12-31T23:59:60Z"), null);
  assert.equal(normalizeDate("2024-01-01T24:00:00Z"), null);
  assert.equal(normalizeDate("2024-01-01T12:60:00Z"), null);
});

test("缺时区、非法偏移、错误格式失败", () => {
  assert.equal(normalizeDate("2024-01-01T12:00:00"), null); // 无时区
  assert.equal(normalizeDate("2024-01-01 12:00:00Z"), null); // 空格分隔
  assert.equal(normalizeDate("2024-01-01T12:00:00+24:00"), null);
  assert.equal(normalizeDate("2024-01-01T12:00:00+08:60"), null);
  assert.equal(normalizeDate("2024-01-01T12:00:00.1234Z"), null); // 小数秒超 3 位
  assert.equal(normalizeDate("2024-1-1T12:00:00Z"), null);
  assert.equal(normalizeDate("not-a-date"), null);
  // @ts-expect-error 运行时防御非字符串
  assert.equal(normalizeDate(12345), null);
});

test("结果不受机器时区影响", () => {
  const prev = process.env.TZ;
  try {
    process.env.TZ = "America/New_York";
    assert.equal(normalizeDate("2024-01-01T00:30:00+08:00"), "2023-12-31T16:30:00.000Z");
    process.env.TZ = "Pacific/Kiritimati";
    assert.equal(normalizeDate("2024-01-01T00:30:00+08:00"), "2023-12-31T16:30:00.000Z");
  } finally {
    if (prev === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = prev;
    }
  }
});
