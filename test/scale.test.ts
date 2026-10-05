import { describe, expect, it } from "vitest";
import { KeywordReviewer, MAX_TEXT_BYTES } from "../src/index.js";

const MISS_WORD_COUNT = 9900;
const HIT_WORD_COUNT = 100;
const PATTERN = "abcdefgh";

function buildWordlist() {
  const entries: Array<{ id: number; word: string }> = [];
  // Miss words: heavy shared prefixes ("m" + common numeric prefixes),
  // never present in the reviewed text.
  for (let i = 0; i < MISS_WORD_COUNT; i++) {
    entries.push({ id: i + 1, word: `m${String(i).padStart(4, "0")}` });
  }
  // Hit words: nested prefixes of the repeating pattern, exercising
  // containment, overlap and same-start matches at scale.
  for (let k = 1; k <= HIT_WORD_COUNT; k++) {
    let word = "";
    while (word.length < k) {
      word += PATTERN;
    }
    entries.push({ id: MISS_WORD_COUNT + k, word: word.slice(0, k) });
  }
  return entries;
}

function buildText(): string {
  const text = PATTERN.repeat(MAX_TEXT_BYTES / PATTERN.length);
  if (Buffer.byteLength(text, "utf8") !== MAX_TEXT_BYTES) {
    throw new Error("test text must be exactly 4 MiB");
  }
  return text;
}

describe("scale: 10000-entry wordlist on 4 MiB repetitive text", () => {
  const entries = buildWordlist();
  const totalWordLength = entries.reduce((sum, e) => sum + e.word.length, 0);
  const reviewer = new KeywordReviewer(entries);
  const text = buildText();

  it("respects the wordlist size budget", () => {
    expect(entries).toHaveLength(10000);
    expect(totalWordLength).toBeLessThanOrEqual(100000);
  });

  it("reports the earliest hit for each of the 100 matching ids only", () => {
    const result = reviewer.review(text);
    expect(result.blocked).toBe(true);
    expect(result.hits).toHaveLength(HIT_WORD_COUNT);
    for (const hit of result.hits) {
      const k = (hit.id as number) - MISS_WORD_COUNT;
      expect(hit.start).toBe(0);
      expect(hit.end).toBe(k);
    }
  });

  it("keeps earliest-per-id when a rare word repeats in a long text", () => {
    const planted = "m0042";
    const firstAt = 8000;
    const secondAt = 16000 + planted.length;
    let text2 =
      PATTERN.repeat(firstAt / PATTERN.length) +
      planted +
      PATTERN.repeat(2000) +
      planted;
    while (text2.length < MAX_TEXT_BYTES) {
      text2 += PATTERN;
    }
    text2 = text2.slice(0, MAX_TEXT_BYTES);
    expect(Buffer.byteLength(text2, "utf8")).toBe(MAX_TEXT_BYTES);
    const result = reviewer.review(text2);
    const hit = result.hits.find((h) => h.id === 43);
    expect(hit).toEqual({ id: 43, start: firstAt, end: firstAt + planted.length });
  });

  it("reviews 10 x 4 MiB texts within the time and memory budget", () => {
    globalThis.gc?.();
    const heapBefore = process.memoryUsage().heapUsed;
    const started = performance.now();
    for (let round = 0; round < 10; round++) {
      const result = reviewer.review(text);
      expect(result.blocked).toBe(true);
      expect(result.hits).toHaveLength(HIT_WORD_COUNT);
    }
    const elapsedMs = performance.now() - started;
    globalThis.gc?.();
    const heapGrowth = process.memoryUsage().heapUsed - heapBefore;
    console.log(
      `10 x 4 MiB reviews: ${elapsedMs.toFixed(0)} ms, ` +
        `heap growth ${(heapGrowth / 1024 / 1024).toFixed(1)} MiB`,
    );
    expect(elapsedMs).toBeLessThan(8000);
    // The 256 MiB peak budget covers the whole process; retained heap after
    // the reviews must stay far below it (per-text buffers are transient).
    expect(heapGrowth).toBeLessThan(128 * 1024 * 1024);
  }, 60000);
});
