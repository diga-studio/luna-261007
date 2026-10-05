import { describe, expect, it } from "vitest";
import { KeywordReviewer } from "../src/index.js";

describe("acceptance: equivalence, ignored chars, supplementary plane", () => {
  // Wordlist: 1 -> "ab", 2 -> "ＡＢ" (fullwidth), 3 -> "b".
  // Text: "😀Ａ" + U+200B + "Ｂb".
  const reviewer = new KeywordReviewer([
    { id: 1, word: "ab" },
    { id: 2, word: "ＡＢ" },
    { id: 3, word: "b" },
  ]);
  const text = "😀Ａ​Ｂb";
  const result = reviewer.review(text);

  it("blocks the content", () => {
    expect(result.blocked).toBe(true);
  });

  it("reports ids 1 and 2 at [2, 5)", () => {
    const hit1 = result.hits.find((h) => h.id === 1);
    const hit2 = result.hits.find((h) => h.id === 2);
    expect(hit1).toEqual({ id: 1, start: 2, end: 5 });
    expect(hit2).toEqual({ id: 2, start: 2, end: 5 });
  });

  it("reports id 3 at [4, 5)", () => {
    const hit3 = result.hits.find((h) => h.id === 3);
    expect(hit3).toEqual({ id: 3, start: 4, end: 5 });
  });

  it("reports exactly one hit per id", () => {
    expect(result.hits).toHaveLength(3);
  });

  it("ranges highlight the original text correctly", () => {
    for (const hit of result.hits) {
      expect(text.length).toBeGreaterThanOrEqual(hit.end);
    }
    expect(text.slice(2, 5)).toBe("Ａ​Ｂ");
    expect(text.slice(4, 5)).toBe("Ｂ");
  });
});
