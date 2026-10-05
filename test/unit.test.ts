import test from "node:test";
import assert from "node:assert/strict";
import { convertUnit } from "../src/unit.js";

test("基本换算与定长输出", () => {
  assert.equal(convertUnit("123456", "1", "100", 2), "1234.56");
  assert.equal(convertUnit("10", "1", "3", 2), "3.33");
  assert.equal(convertUnit("10", "2", "3", 2), "6.67");
  assert.equal(convertUnit("2.5", "4", "1", 1), "10.0");
  assert.equal(convertUnit("7", "1", "1", 0), "7");
  assert.equal(convertUnit("0", "1", "1", 3), "0.000");
});

test("30 位有效数字与 12 位小数精确处理", () => {
  assert.equal(
    convertUnit("123456789012345678901234567890", "1", "1", 0),
    "123456789012345678901234567890",
  );
  // (10^30 - 1) * 3 / 7 = 428571428571428571428571428571 恰好整除
  assert.equal(
    convertUnit("999999999999999999999999999999", "3", "7", 6),
    "428571428571428571428571428571.000000",
  );
  // 12 位小数输入 * 大分子
  assert.equal(convertUnit("0.000000000001", "1000000", "1", 6), "0.000001");
  // 30 位有效数字带 12 位小数
  assert.equal(
    convertUnit("123456789012345678.901234567890", "2", "1", 6),
    "246913578024691357.802469",
  );
});

test("正负中点均取偶数末位", () => {
  // 正数中点
  assert.equal(convertUnit("0.005", "1", "1", 2), "0.00"); // 0 偶
  assert.equal(convertUnit("0.015", "1", "1", 2), "0.02"); // 2 偶
  assert.equal(convertUnit("0.025", "1", "1", 2), "0.02"); // 2 偶
  assert.equal(convertUnit("0.035", "1", "1", 2), "0.04"); // 4 偶
  // 负数中点：同样取偶
  assert.equal(convertUnit("-0.005", "1", "1", 2), "0.00");
  assert.equal(convertUnit("-0.015", "1", "1", 2), "-0.02");
  assert.equal(convertUnit("-0.025", "1", "1", 2), "-0.02");
  assert.equal(convertUnit("-0.035", "1", "1", 2), "-0.04");
  // 非中点按最近值
  assert.equal(convertUnit("0.0151", "1", "1", 2), "0.02");
  assert.equal(convertUnit("0.0149", "1", "1", 2), "0.01");
  assert.equal(convertUnit("-0.0151", "1", "1", 2), "-0.02");
  // 经倍率后落在中点：2.5 * 1 / 2 = 1.25，scale 1 -> 1.2
  assert.equal(convertUnit("2.5", "1", "2", 1), "1.2");
  assert.equal(convertUnit("7.5", "1", "2", 1), "3.8"); // 3.75 -> 3.8
});

test("负零归一为正零", () => {
  assert.equal(convertUnit("-0.004", "1", "1", 2), "0.00");
  assert.equal(convertUnit("-0.0000001", "1", "1", 6), "0.000000");
  assert.equal(convertUnit("-0", "1", "1", 2), "0.00");
  assert.equal(convertUnit("-0.0", "5", "1", 0), "0");
});

test("非法输入失败", () => {
  assert.equal(convertUnit("1e5", "1", "1", 2), null); // 指数
  assert.equal(convertUnit("1.2.3", "1", "1", 2), null);
  assert.equal(convertUnit("abc", "1", "1", 2), null);
  assert.equal(convertUnit("", "1", "1", 2), null);
  assert.equal(convertUnit("1", "1.5", "1", 2), null); // 分子非整数
  assert.equal(convertUnit("1", "1", "0", 2), null); // 分母为零
  assert.equal(convertUnit("1", "1", "-2", 2), null); // 分母非正
  assert.equal(convertUnit("1", "1", "1", 7), null); // 精度超界
  assert.equal(convertUnit("1", "1", "1", -1), null);
  // @ts-expect-error 运行时防御非字符串
  assert.equal(convertUnit(12, "1", "1", 2), null);
});
