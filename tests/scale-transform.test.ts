import { test } from "node:test";
import { deepEqual, ok } from "node:assert/strict";
import { KeywordReviewer, MAX_TEXT_BYTES } from "../src/index.js";

test("规模场景（含零宽与全角字符的文本）：位置映射与耗时内存", () => {
  const entries = [{ id: 1, word: "秘密ab" }];
  for (let i = 0; i < 5000; i++) {
    entries.push({ id: 100 + i, word: "未命中词" + i });
  }
  const reviewer = KeywordReviewer.fromEntries(entries);

  // 填充文本中混入零宽字符与全角字符，强制走位置映射路径
  const filler = "Ｌorem\u200B ipsum Ｄolor\uFEFF sit amet. ";
  const hit = "秘\u200B密ＡＢ"; // 归一化后 = "秘密ab"
  const hitPos = 2_000_000;
  const base = filler.repeat(Math.ceil(MAX_TEXT_BYTES / filler.length));
  // 全角与零宽字符均为多字节 UTF-8，按字符数预留充足余量
  const text = base.slice(0, hitPos) + hit + base.slice(hitPos, 3_300_000);
  ok(new TextEncoder().encode(text).length <= MAX_TEXT_BYTES, "text exceeds 4 MiB");

  const start = Date.now();
  let result = null as ReturnType<KeywordReviewer["review"]> | null;
  for (let round = 0; round < 10; round++) {
    result = reviewer.review(text);
  }
  const elapsed = Date.now() - start;

  deepEqual(result!.hits, [{ id: 1, start: hitPos, end: hitPos + hit.length }]);
  const rssMiB = process.memoryUsage().rss / (1024 * 1024);
  ok(elapsed <= 8000, `10 reviews took ${elapsed}ms (> 8000ms)`);
  ok(rssMiB <= 256, `peak rss ${rssMiB.toFixed(1)} MiB (> 256 MiB)`);
  console.log(`    scale-transform: 10 x ~4 MiB reviews in ${elapsed}ms, rss ${rssMiB.toFixed(1)} MiB`);
});
