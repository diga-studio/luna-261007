import { test } from "node:test";
import assert from "node:assert/strict";
import {
  firstSundayOfNovember,
  formatDate,
  parseDate,
  secondSundayOfMarch,
  weekdayOf,
  yearOf,
} from "../src/date";

test("parseDate/formatDate 往返一致", () => {
  const cases = [
    "2008-01-01",
    "2008-02-29",
    "2024-03-10",
    "2024-11-03",
    "1999-12-31".replace("1999", "9999"),
    "9999-12-31",
    "2400-02-29",
    "2100-02-28",
  ];
  for (const c of cases) {
    assert.equal(formatDate(parseDate(c)), c);
  }
});

test("weekdayOf 已知星期", () => {
  assert.equal(weekdayOf(parseDate("2008-01-01")), 1); // 周二
  assert.equal(weekdayOf(parseDate("2008-01-07")), 0); // 周一
  assert.equal(weekdayOf(parseDate("2024-03-10")), 6); // 周日
  assert.equal(weekdayOf(parseDate("2024-11-03")), 6); // 周日
  assert.equal(weekdayOf(parseDate("9999-12-31")), 4); // 周五
});

test("闰年规则", () => {
  assert.throws(() => parseDate("2100-02-29")); // 2100 非闰年
  assert.equal(formatDate(parseDate("2400-02-29")), "2400-02-29"); // 2400 闰年
  assert.throws(() => parseDate("2023-02-29"));
});

test("非法日期拒绝", () => {
  assert.throws(() => parseDate("2007-12-31")); // 早于 2008
  assert.throws(() => parseDate("10000-01-01"));
  assert.throws(() => parseDate("2024-13-01"));
  assert.throws(() => parseDate("2024-00-10"));
  assert.throws(() => parseDate("2024-01-32"));
  assert.throws(() => parseDate("2024-1-1"));
  assert.throws(() => parseDate("abcd-ef-gh"));
});

test("DST 过渡星期日", () => {
  // 2024: 3 月第二个周日 = 03-10；11 月第一个周日 = 11-03
  assert.equal(formatDate(secondSundayOfMarch(2024)), "2024-03-10");
  assert.equal(formatDate(firstSundayOfNovember(2024)), "2024-11-03");
  // 2008: 03-09 / 11-02；9999: 03-14 / 11-07
  assert.equal(formatDate(secondSundayOfMarch(2008)), "2008-03-09");
  assert.equal(formatDate(firstSundayOfNovember(2008)), "2008-11-02");
  assert.equal(formatDate(secondSundayOfMarch(9999)), "9999-03-14");
  assert.equal(formatDate(firstSundayOfNovember(9999)), "9999-11-07");
});

test("yearOf", () => {
  assert.equal(yearOf(parseDate("2008-01-01")), 2008);
  assert.equal(yearOf(parseDate("9999-12-31")), 9999);
  assert.equal(yearOf(parseDate("2024-06-15")), 2024);
});
