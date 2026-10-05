import { describe, expect, it } from "vitest";
import { KeywordReviewer, MAX_TEXT_BYTES } from "../src/index.js";

describe("skeleton", () => {
  it("exposes the public API", () => {
    expect(typeof KeywordReviewer).toBe("function");
    expect(MAX_TEXT_BYTES).toBe(4 * 1024 * 1024);
  });
});
