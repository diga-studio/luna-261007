import { test } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import { KeywordReviewer, MAX_TEXT_BYTES } from "../src/index.js";

test("规模场景：10000 词、10 份 4 MiB 文本，耗时与内存达标", () => {
  // 10000 个词：共享前缀 "αβγ" 与后缀 "δ"，另加 200 个逐层嵌套词，
  // 归一化后总长度不超过 100000 码点。
  const entries = [];
  let totalLen = 0;
  for (let i = 0; i < 9800; i++) {
    const word = "αβγ" + i.toString(36).padStart(4, "0") + "δ";
    totalLen += word.length;
    entries.push({ id: i + 1, word });
  }
  for (let i = 1; i <= 200; i++) {
    const word = "ζ" + "η".repeat(i);
    totalLen += word.length;
    entries.push({ id: 10000 + i, word });
  }
  ok(totalLen <= 100000, `lexicon total length ${totalLen} exceeds budget`);

  const reviewer = KeywordReviewer.fromEntries(entries);

  // 约 4 MiB 文本：长重复填充，绝大多数词始终不命中；
  // 编号 1 出现两次（验证逐编号最早命中），编号 10200 出现一次。
  const filler = "the quick brown fox jumps over the lazy dog. ".repeat(100);
  const hitWord1 = entries[0]!.word; // αβγ0000δ
  const hitWord2 = entries[entries.length - 1]!.word; // ζη*200
  const firstPos = 12345;
  const secondPos = 3000000;
  const tailLen = 7;
  const base = filler.repeat(Math.ceil(MAX_TEXT_BYTES / filler.length));
  const mid = base.slice(firstPos, secondPos);
  const rest = base.slice(secondPos, MAX_TEXT_BYTES - 1024);
  const pos2 = firstPos + hitWord1.length + mid.length;
  const pos3 = pos2 + hitWord1.length + rest.length;
  const text = base.slice(0, firstPos) + hitWord1 + mid + hitWord1 + rest + hitWord2 + "x".repeat(tailLen);
  ok(new TextEncoder().encode(text).length <= MAX_TEXT_BYTES, "text exceeds 4 MiB");

  const start = Date.now();
  let lastResult = null as ReturnType<KeywordReviewer["review"]> | null;
  for (let round = 0; round < 10; round++) {
    lastResult = reviewer.review(text);
  }
  const elapsed = Date.now() - start;

  // hitWord2 = "ζη*200"，其所有前缀词 "ζη^i"（i=1..200）也在同一处命中
  const expectedHits = [
    { id: 1, start: firstPos, end: firstPos + hitWord1.length },
  ];
  for (let i = 1; i <= 200; i++) {
    expectedHits.push({ id: 10000 + i, start: pos3, end: pos3 + i + 1 });
  }
  deepEqual(lastResult!.hits, expectedHits);
  equal(lastResult!.blocked, true);

  const rssMiB = process.memoryUsage().rss / (1024 * 1024);
  ok(elapsed <= 8000, `10 reviews took ${elapsed}ms (> 8000ms)`);
  ok(rssMiB <= 256, `peak rss ${rssMiB.toFixed(1)} MiB (> 256 MiB)`);
  console.log(`    scale: 10 x ~4 MiB reviews in ${elapsed}ms, rss ${rssMiB.toFixed(1)} MiB`);
});
