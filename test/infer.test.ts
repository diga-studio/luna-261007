import test from "node:test";
import assert from "node:assert/strict";
import { ColumnInferer, convertCell, matchType } from "../src/infer.js";
import type { ColumnType } from "../src/types.js";

function infer(samples: (string | null)[]): ColumnType {
  const inf = new ColumnInferer();
  for (const s of samples) {
    if (s === null || s === "") inf.addEmpty();
    else inf.addSample(s);
  }
  return inf.decide();
}

function repeat(value: string | null, n: number): (string | null)[] {
  return Array.from({ length: n }, () => value);
}

test("boolean 只认不区分大小写的 true/false", () => {
  assert.equal(matchType("true", "boolean"), true);
  assert.equal(matchType("FALSE", "boolean"), true);
  assert.equal(matchType("tRue", "boolean"), true);
  assert.equal(matchType("yes", "boolean"), false);
  assert.equal(matchType("1", "boolean"), false);
  assert.equal(matchType(" true", "boolean"), false);
  assert.equal(matchType("true ", "boolean"), false);
});

test("integer 可带正负号且须在安全整数范围", () => {
  assert.equal(matchType("0", "integer"), true);
  assert.equal(matchType("-42", "integer"), true);
  assert.equal(matchType("+9007199254740991", "integer"), true);
  assert.equal(matchType("9007199254740992", "integer"), false);
  assert.equal(matchType("-9007199254740992", "integer"), false);
  assert.equal(matchType("1.0", "integer"), false);
  assert.equal(matchType("1e3", "integer"), false);
});

test("float 规则：整数部分必需、小数点后须有数字、指数至少一位、数值有限", () => {
  assert.equal(matchType("3.14", "float"), true);
  assert.equal(matchType("-2.5e-3", "float"), true);
  assert.equal(matchType("1E+10", "float"), true);
  assert.equal(matchType("42", "float"), true);
  assert.equal(matchType(".5", "float"), false);
  assert.equal(matchType("5.", "float"), false);
  assert.equal(matchType("1e", "float"), false);
  assert.equal(matchType("1e+", "float"), false);
  assert.equal(matchType("1e999", "float"), false);
  // 超安全范围的纯整数字面量不匹配 float。
  assert.equal(matchType("9007199254740993", "float"), false);
  assert.equal(matchType("9007199254740993.5", "float"), true);
});

test("date 严格 MM/DD/YYYY 真实公历日期，年份 0001-9999", () => {
  assert.equal(matchType("02/29/2000", "date"), true);
  assert.equal(matchType("02/29/1900", "date"), false);
  assert.equal(matchType("02/29/2004", "date"), true);
  assert.equal(matchType("12/31/9999", "date"), true);
  assert.equal(matchType("01/01/0001", "date"), true);
  assert.equal(matchType("01/01/0000", "date"), false);
  assert.equal(matchType("13/01/2000", "date"), false);
  assert.equal(matchType("04/31/2000", "date"), false);
  assert.equal(matchType("1/1/2000", "date"), false);
  assert.equal(matchType("2000-01-01", "date"), false);
});

test("url 仅 http(s)、主机非空、scheme 不区分大小写", () => {
  assert.equal(matchType("http://example.com", "url"), true);
  assert.equal(matchType("HTTPS://EXAMPLE.COM/a?b=c#d", "url"), true);
  assert.equal(matchType("https://例え.jp/パス", "url"), true);
  assert.equal(matchType("ftp://example.com", "url"), false);
  assert.equal(matchType("https://", "url"), false);
  assert.equal(matchType("example.com", "url"), false);
  assert.equal(matchType(" http://example.com", "url"), false);
});

test("email 规则", () => {
  assert.equal(matchType("a.b+x%y-z@sub.example.com", "email"), true);
  assert.equal(matchType("a@b.co", "email"), true);
  assert.equal(matchType("a@b.c", "email"), false);
  assert.equal(matchType("a b@c.com", "email"), false);
  assert.equal(matchType("a@@b.com", "email"), false);
  assert.equal(matchType("@b.com", "email"), false);
  assert.equal(matchType("a@-b.com", "email"), false);
  assert.equal(matchType("a@b-.com", "email"), false);
  assert.equal(matchType("a@b..com", "email"), false);
  assert.equal(matchType("a@b.c_m", "email"), false);
});

test("首尾含 White_Space 的非空值只能匹配 text", () => {
  for (const v of [" 1", "1\t", " true ", "﻿1"]) {
    for (const t of ["boolean", "integer", "float", "date", "url", "email"] as const) {
      assert.equal(matchType(v, t), false, `${JSON.stringify(v)} vs ${t}`);
    }
  }
});

test("恰好 80% 命中即有资格", () => {
  // 100 个非空样本，80 个 integer。
  const samples = [...repeat("5", 80), ...repeat("x", 20)];
  assert.equal(infer(samples), "integer");
  // 79 个则不够。
  assert.equal(infer([...repeat("5", 79), ...repeat("x", 21)]), "text");
});

test("空值不计入分母", () => {
  // 60 空 + 40 非空，其中 32 个 integer = 80%。
  const samples = [...repeat(null, 60), ...repeat("7", 32), ...repeat("x", 8)];
  assert.equal(infer(samples), "integer");
  assert.equal(infer([...repeat(null, 60), ...repeat("7", 31), ...repeat("x", 9)]), "text");
});

test("全空列为 text", () => {
  assert.equal(infer(repeat(null, 100)), "text");
  assert.equal(infer([]), "text");
});

test("integer 与 float 同时达标时取 integer（优先级在前）", () => {
  assert.equal(infer(repeat("5", 100)), "integer");
  assert.equal(infer(repeat("1.5", 100)), "float");
  assert.equal(infer([...repeat("5", 50), ...repeat("1.5", 50)]), "float");
});

test("类型优先级顺序 boolean < integer < float < date < url < email", () => {
  assert.equal(infer(repeat("true", 100)), "boolean");
  // 全部既是 float 又是合法值时 integer 优先（见上）；date/url/email 各自独立。
  assert.equal(infer(repeat("01/02/2003", 100)), "date");
  assert.equal(infer(repeat("http://a.com", 100)), "url");
  assert.equal(infer(repeat("a@b.com", 100)), "email");
});

test("convertCell：空值输出 null，其他类型保持原文", () => {
  assert.deepEqual(convertCell("", "integer"), { ok: true, value: null });
  assert.deepEqual(convertCell("TRUE", "boolean"), { ok: true, value: true });
  assert.deepEqual(convertCell("-7", "integer"), { ok: true, value: -7 });
  assert.deepEqual(convertCell("2.5e2", "float"), { ok: true, value: 250 });
  assert.deepEqual(convertCell("01/02/2003", "date"), { ok: true, value: "01/02/2003" });
  assert.deepEqual(convertCell(" x ", "text"), { ok: true, value: " x " });
  assert.deepEqual(convertCell("abc", "integer"), { ok: false });
  assert.deepEqual(convertCell("1e999", "float"), { ok: false });
});
