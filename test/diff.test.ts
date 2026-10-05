import test from "node:test";
import { deepEqual } from "node:assert/strict";
import { diffLines } from "../src/diff";

test("完全相同没有改动", () => {
  deepEqual(diffLines(["a\n", "b\n"], ["a\n", "b\n"]), []);
});

test("两侧都为空没有改动", () => {
  deepEqual(diffLines([], []), []);
});

test("纯插入定位在祖先的行间位置", () => {
  deepEqual(diffLines(["a\n", "b\n"], ["a\n", "x\n", "b\n"]), [
    { start: 1, end: 1, lines: ["x\n"] },
  ]);
});

test("从空祖先全部插入", () => {
  deepEqual(diffLines([], ["a\n", "b\n"]), [
    { start: 0, end: 0, lines: ["a\n", "b\n"] },
  ]);
});

test("纯删除", () => {
  deepEqual(diffLines(["a\n", "b\n", "c\n"], ["a\n", "c\n"]), [
    { start: 1, end: 2, lines: [] },
  ]);
});

test("全部删除", () => {
  deepEqual(diffLines(["a\n", "b\n"], []), [{ start: 0, end: 2, lines: [] }]);
});

test("连续删除和插入合为一个改动", () => {
  deepEqual(diffLines(["a\n", "b\n", "c\n"], ["a\n", "x\n", "y\n"]), [
    { start: 1, end: 3, lines: ["x\n", "y\n"] },
  ]);
});

test("保留行隔开改动", () => {
  deepEqual(diffLines(["a\n", "b\n", "c\n"], ["A\n", "b\n", "C\n"]), [
    { start: 0, end: 1, lines: ["A\n"] },
    { start: 2, end: 3, lines: ["C\n"] },
  ]);
});

test("末行无 LF 与有 LF 是不同的行", () => {
  deepEqual(diffLines(["a\n", "b"], ["a\n", "b\n"]), [
    { start: 1, end: 2, lines: ["b\n"] },
  ]);
});

test("不规范化空白：仅空白不同也算改动", () => {
  deepEqual(diffLines(["a \n"], ["a\n"]), [{ start: 0, end: 1, lines: ["a\n"] }]);
});

test("并列时操作序列按 保留<删除<插入 取字典序最小", () => {
  // a b -> b a：删 a 保留 b 插 a（delete,keep,insert）
  // 优于 插 b 保留 b 删 b（insert,keep,delete）。
  deepEqual(diffLines(["a\n", "b\n"], ["b\n", "a\n"]), [
    { start: 0, end: 1, lines: [] },
    { start: 2, end: 2, lines: ["a\n"] },
  ]);
});

test("并列时保留优先于删除", () => {
  // a -> a a：保留第一个 a 再插入，优于删除再保留。
  deepEqual(diffLines(["a\n"], ["a\n", "a\n"]), [
    { start: 1, end: 1, lines: ["a\n"] },
  ]);
});
