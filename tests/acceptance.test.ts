import { test } from "node:test";
import { deepEqual, equal, ok, throws } from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeywordReviewer } from "../src/index.js";

test("验收场景：等价词、忽略字符与补充平面字符共同定位", () => {
  const reviewer = KeywordReviewer.fromEntries([
    { id: 1, word: "ab" },
    { id: 2, word: "ＡＢ" },
    { id: 3, word: "b" },
  ]);
  const text = "😀Ａ\u200BＢb";
  const result = reviewer.review(text);
  equal(result.blocked, true);
  deepEqual(result.hits, [
    { id: 1, start: 2, end: 5 },
    { id: 2, start: 2, end: 5 },
    { id: 3, start: 4, end: 5 },
  ]);
  // 范围可直接用于原文高亮
  equal(text.slice(2, 5), "Ａ\u200BＢ");
  equal(text.slice(4, 5), "Ｂ");
});

test("等价规则：大小写、全角、零宽字符都不能绕过", () => {
  const reviewer = KeywordReviewer.fromEntries([
    { id: 1, word: "Hello" },
    { id: 2, word: "ｆｏｏ" },
    { id: 3, word: "禁\u200B词" },
  ]);
  const r1 = reviewer.review("say hELLo!");
  deepEqual(r1.hits, [{ id: 1, start: 4, end: 9 }]);
  const r2 = reviewer.review("a FｏO b");
  deepEqual(r2.hits, [{ id: 2, start: 2, end: 5 }]);
  // 词内含零宽字符等价于不含；文本中的零宽字符同样被忽略
  const r3 = reviewer.review("这是禁\uFEFF\u200D词啊");
  deepEqual(r3.hits, [{ id: 3, start: 2, end: 6 }]);
});

test("字面匹配：普通空格、换行、标点不可跳过", () => {
  const reviewer = KeywordReviewer.fromEntries([{ id: 1, word: "a b" }]);
  equal(reviewer.review("a b").blocked, true);
  equal(reviewer.review("a  b").blocked, false);
  equal(reviewer.review("a\nb").blocked, false);
  equal(reviewer.review("a,b").blocked, false);
});

test("连续子串命中，不要求分隔符；包含与重叠分别识别", () => {
  const reviewer = KeywordReviewer.fromEntries([
    { id: 1, word: "abc" },
    { id: 2, word: "bc" },
    { id: 3, word: "bcd" },
  ]);
  const result = reviewer.review("xabcd");
  equal(result.blocked, true);
  deepEqual(result.hits, [
    { id: 1, start: 1, end: 4 },
    { id: 2, start: 2, end: 4 },
    { id: 3, start: 2, end: 5 },
  ]);
});

test("每个编号只报告最早的一处", () => {
  const reviewer = KeywordReviewer.fromEntries([{ id: 7, word: "aa" }]);
  const result = reviewer.review("aaaa");
  deepEqual(result.hits, [{ id: 7, start: 0, end: 2 }]);
});

test("无命中时不拦截", () => {
  const reviewer = KeywordReviewer.fromEntries([{ id: 1, word: "xyz" }]);
  const result = reviewer.review("hello world");
  equal(result.blocked, false);
  deepEqual(result.hits, []);
});

test("词库校验：归一化后为空的词语被拒绝", () => {
  throws(() => KeywordReviewer.fromEntries([{ id: 1, word: "\u200B\uFEFF" }]));
  throws(() => KeywordReviewer.fromEntries([{ id: 1, word: "" }]));
});

test("从本地 JSON 文件载入词库", () => {
  const dir = mkdtempSync(join(tmpdir(), "lexicon-"));
  try {
    const file = join(dir, "lexicon.json");
    writeFileSync(file, JSON.stringify([{ id: 1, word: "秘密" }]));
    const reviewer = KeywordReviewer.loadFromFile(file);
    const result = reviewer.review("这是秘密文本");
    deepEqual(result.hits, [{ id: 1, start: 2, end: 4 }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("超出 4 MiB 的文本被拒绝", () => {
  const reviewer = KeywordReviewer.fromEntries([{ id: 1, word: "a" }]);
  const big = "a".repeat(4 * 1024 * 1024 + 1);
  throws(() => reviewer.review(big));
  ok(reviewer.review("a".repeat(4 * 1024 * 1024)).blocked);
});

test("边界：空文本与空词库", () => {
  const reviewer = KeywordReviewer.fromEntries([{ id: 1, word: "a" }]);
  deepEqual(reviewer.review(""), { blocked: false, hits: [] });
  const empty = KeywordReviewer.fromEntries([]);
  deepEqual(empty.review("anything"), { blocked: false, hits: [] });
});

test("补充平面字符参与匹配时的 UTF-16 定位", () => {
  const reviewer = KeywordReviewer.fromEntries([{ id: 1, word: "😀b" }]);
  // 😀 占 2 个 UTF-16 码元
  const result = reviewer.review("x😀By");
  deepEqual(result.hits, [{ id: 1, start: 1, end: 4 }]);
});
