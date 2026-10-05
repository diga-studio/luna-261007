import test from "node:test";
import { deepEqual, equal } from "node:assert/strict";
import { joinLines, splitLines } from "../src/lines";

test("空文本为零行", () => {
  deepEqual(splitLines(""), []);
});

test("LF 属于前一行", () => {
  deepEqual(splitLines("a\nb\n"), ["a\n", "b\n"]);
});

test("末行允许无 LF", () => {
  deepEqual(splitLines("a\nb"), ["a\n", "b"]);
});

test("末尾 LF 不产生额外空行", () => {
  deepEqual(splitLines("a\n"), ["a\n"]);
});

test("单个 LF 是一行", () => {
  deepEqual(splitLines("\n"), ["\n"]);
});

test("中间的空行保留", () => {
  deepEqual(splitLines("a\n\nb"), ["a\n", "\n", "b"]);
});

test("无 LF 的单行", () => {
  deepEqual(splitLines("abc"), ["abc"]);
});

test("拼接是分割的逆操作", () => {
  for (const text of ["", "a", "a\n", "a\nb", "a\nb\n", "\n\n", "a\n\nb\n"]) {
    equal(joinLines(splitLines(text)), text);
  }
});
