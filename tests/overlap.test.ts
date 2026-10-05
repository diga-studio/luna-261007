import { test } from "node:test";
import { deepEqual, equal } from "node:assert/strict";
import { KeywordReviewer } from "../src/index.js";
import { normalizeText, normalizeWord } from "../src/normalize.js";

test("大量包含及重叠词在长重复文本中全部命中", () => {
  const entries = [];
  for (let i = 1; i <= 200; i++) {
    entries.push({ id: i, word: "a".repeat(i) });
  }
  for (let i = 1; i <= 100; i++) {
    entries.push({ id: 1000 + i, word: "a".repeat(i) + "b" });
  }
  const reviewer = KeywordReviewer.fromEntries(entries);

  // 长重复文本：("a"*300 + "b") 重复 3000 次，约 90 万字符
  const text = ("a".repeat(300) + "b").repeat(3000);
  const result = reviewer.review(text);

  equal(result.blocked, true);
  equal(result.hits.length, 300);
  const byId = new Map(result.hits.map((h) => [h.id, h]));
  // "a"^i：最早命中从 0 开始
  for (let i = 1; i <= 200; i++) {
    deepEqual(byId.get(i), { id: i, start: 0, end: i });
  }
  // "a"^i + "b"：最早命中结束于第一个 "b"（原文下标 300）
  for (let i = 1; i <= 100; i++) {
    deepEqual(byId.get(1000 + i), { id: 1000 + i, start: 300 - i, end: 301 });
  }
});

test("与暴力参考实现交叉验证（随机等价字符、包含与重叠词）", () => {
  // 每个归一化字符的多种原文写法
  const variants: Record<string, string[]> = {
    a: ["a", "A", "Ａ", "ａ"],
    b: ["b", "B", "Ｂ", "ｂ"],
    c: ["c", "C", "Ｃ", "ｃ"],
    "1": ["1", "１"],
    "😀": ["😀"],
  };
  const keys = Object.keys(variants);
  const zeroWidth = ["\u200B", "\u200C", "\u200D", "\uFEFF"];
  let seed = 42;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)]!;

  // 随机词库：故意包含互为前缀/包含关系的词
  const baseWords = ["ab", "abc", "b", "aabb", "😀a", "c1", "abcabc"];
  const entries = baseWords.map((w, i) => ({ id: i + 1, word: w }));
  for (let i = 0; i < 30; i++) {
    const len = 1 + Math.floor(rand() * 4);
    let w = "";
    for (let j = 0; j < len; j++) w += pick(keys);
    entries.push({ id: 100 + i, word: w });
  }
  const reviewer = KeywordReviewer.fromEntries(entries);

  // 随机文本：词的变体写法 + 零宽字符 + 普通字符
  let text = "";
  for (let i = 0; i < 400; i++) {
    const r = rand();
    if (r < 0.3) {
      const w = pick(baseWords)!;
      for (const ch of w) text += pick(variants[ch] ?? [ch]);
    } else if (r < 0.4) {
      text += pick(zeroWidth);
    } else {
      text += pick(pick(Object.values(variants)));
    }
  }

  // 暴力参考：在归一化码点序列上滑动每个归一化词，取最早命中
  const { normalized, map } = normalizeText(text);
  const nchars = [...normalized];
  const at = (normIndex: number) => (map === null ? normIndex : map[normIndex]!);
  const expected = new Map<number, { id: number; start: number; end: number }>();
  for (const entry of entries) {
    const wchars = [...normalizeWord(entry.word)];
    outer: for (let i = 0; i + wchars.length <= nchars.length; i++) {
      for (let j = 0; j < wchars.length; j++) {
        if (nchars[i + j] !== wchars[j]) continue outer;
      }
      const start = at(i);
      const lastCp = text.codePointAt(at(i + wchars.length - 1))!;
      const end = at(i + wchars.length - 1) + (lastCp > 0xffff ? 2 : 1);
      expected.set(entry.id, { id: entry.id, start, end });
      break;
    }
  }

  const result = reviewer.review(text);
  equal(result.blocked, expected.size > 0);
  deepEqual([...result.hits], [...expected.values()].sort((a, b) => a.id - b.id));
});
