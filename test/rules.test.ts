import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { KeywordReviewer, MAX_TEXT_BYTES } from "../src/index.js";

function review(entries: Array<{ id: number | string; word: string }>, text: string) {
  return new KeywordReviewer(entries).review(text);
}

describe("equivalence rules", () => {
  it("matches ASCII letters case-insensitively", () => {
    const result = review([{ id: 1, word: "Hello" }], "say hELLo world");
    expect(result.hits).toEqual([{ id: 1, start: 4, end: 9 }]);
  });

  it("treats fullwidth ASCII as halfwidth", () => {
    const result = review([{ id: 1, word: "ｈｅｌｌｏ１２３！" }], "HeLLo123!");
    expect(result.hits).toEqual([{ id: 1, start: 0, end: 9 }]);
  });

  it("ignores zero-width characters inside a match", () => {
    // word: "a" + ZWSP + "b"; text: "x" + ZWNJ + "a" + ZWJ + "b" + BOM + "y"
    const word = "a\u200Bb";
    const text = "x\u200Ca\u200Db\uFEFFy";
    const result = review([{ id: 1, word }], text);
    expect(result.hits).toEqual([{ id: 1, start: 2, end: 5 }]);
    expect(text.slice(2, 5)).toBe("a\u200Db");
  });

  it("excludes ignored characters at the edges of a match", () => {
    const result = review([{ id: 1, word: "ab" }], "\u200Bab\uFEFF");
    expect(result.hits).toEqual([{ id: 1, start: 1, end: 3 }]);
  });

  it("matches ordinary spaces and punctuation literally", () => {
    expect(review([{ id: 1, word: "a b" }], "a b").blocked).toBe(true);
    expect(review([{ id: 1, word: "a b" }], "ab").blocked).toBe(false);
    expect(review([{ id: 1, word: "a,b" }], "a,b").blocked).toBe(true);
    expect(review([{ id: 1, word: "a,b" }], "a.b").blocked).toBe(false);
    expect(review([{ id: 1, word: "a\nb" }], "a\nb").blocked).toBe(true);
    expect(review([{ id: 1, word: "a\nb" }], "a b").blocked).toBe(false);
  });

  it("matches supplementary-plane characters literally", () => {
    const result = review([{ id: 1, word: "😀b" }], "x😀by");
    expect(result.hits).toEqual([{ id: 1, start: 1, end: 4 }]);
  });
});

describe("substring matching", () => {
  it("does not require separators around the word", () => {
    expect(review([{ id: 1, word: "he" }], "she").hits).toEqual([
      { id: 1, start: 1, end: 3 },
    ]);
  });

  it("reports containing and contained words separately", () => {
    const result = review(
      [
        { id: 1, word: "ab" },
        { id: 2, word: "abc" },
        { id: 3, word: "bc" },
        { id: 4, word: "b" },
      ],
      "abc",
    );
    expect(result.hits).toEqual([
      { id: 1, start: 0, end: 2 },
      { id: 2, start: 0, end: 3 },
      { id: 4, start: 1, end: 2 },
      { id: 3, start: 1, end: 3 },
    ]);
  });

  it("reports overlapping words", () => {
    const result = review(
      [
        { id: 1, word: "ana" },
        { id: 2, word: "nan" },
      ],
      "banana",
    );
    expect(result.hits).toEqual([
      { id: 1, start: 1, end: 4 },
      { id: 2, start: 2, end: 5 },
    ]);
  });

  it("reports multiple words starting at the same position", () => {
    const result = review(
      [
        { id: 1, word: "a" },
        { id: 2, word: "ab" },
        { id: 3, word: "abc" },
      ],
      "abc",
    );
    expect(result.hits.map((h) => h.id).sort()).toEqual([1, 2, 3]);
    for (const hit of result.hits) {
      expect(hit.start).toBe(0);
    }
  });
});

describe("earliest hit per id", () => {
  it("reports only the first occurrence of each id", () => {
    const result = review([{ id: 1, word: "aa" }], "aaaa");
    expect(result.hits).toEqual([{ id: 1, start: 0, end: 2 }]);
  });

  it("reports equivalent entries under their own ids", () => {
    const result = review(
      [
        { id: 1, word: "ab" },
        { id: 2, word: "AB" },
        { id: 3, word: "ＡＢ" },
      ],
      "xxabyy",
    );
    expect(result.hits).toEqual([
      { id: 1, start: 2, end: 4 },
      { id: 2, start: 2, end: 4 },
      { id: 3, start: 2, end: 4 },
    ]);
  });

  it("supports string ids", () => {
    const result = review([{ id: "w-1", word: "bad" }], "very bad");
    expect(result.hits).toEqual([{ id: "w-1", start: 5, end: 8 }]);
  });
});

describe("wordlist loading and validation", () => {
  it("loads entries from a JSON file", () => {
    const dir = mkdtempSync(join(tmpdir(), "wordlist-"));
    const file = join(dir, "words.json");
    writeFileSync(file, JSON.stringify([{ id: 7, word: "禁词" }]));
    const reviewer = KeywordReviewer.loadFromFile(file);
    expect(reviewer.review("这是禁词内容").hits).toEqual([
      { id: 7, start: 2, end: 4 },
    ]);
    expect(reviewer.review("正常内容").blocked).toBe(false);
  });

  it("rejects words that are empty after normalization", () => {
    expect(() => new KeywordReviewer([{ id: 1, word: "\u200B" }])).toThrow(
      /empty after normalization/,
    );
    expect(() => new KeywordReviewer([{ id: 1, word: "" }])).toThrow();
  });

  it("rejects duplicate ids", () => {
    expect(
      () =>
        new KeywordReviewer([
          { id: 1, word: "a" },
          { id: 1, word: "b" },
        ]),
    ).toThrow(/duplicate/);
  });

  it("rejects malformed entries", () => {
    expect(() => new KeywordReviewer([{ id: 1 } as never])).toThrow(TypeError);
    expect(
      () => new KeywordReviewer([{ id: {}, word: "a" } as never]),
    ).toThrow(TypeError);
  });

  it("rejects text larger than 4 MiB (UTF-8)", () => {
    const reviewer = new KeywordReviewer([{ id: 1, word: "a" }]);
    const tooBig = "a".repeat(MAX_TEXT_BYTES + 1);
    expect(() => reviewer.review(tooBig)).toThrow(RangeError);
    const justFits = "a".repeat(MAX_TEXT_BYTES);
    expect(reviewer.review(justFits).blocked).toBe(true);
  });

  it("handles an empty wordlist and empty text", () => {
    const reviewer = new KeywordReviewer([]);
    expect(reviewer.review("anything")).toEqual({ blocked: false, hits: [] });
    const reviewer2 = new KeywordReviewer([{ id: 1, word: "a" }]);
    expect(reviewer2.review("")).toEqual({ blocked: false, hits: [] });
  });
});
