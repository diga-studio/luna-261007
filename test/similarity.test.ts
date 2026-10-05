import assert from "node:assert/strict";
import { test } from "node:test";
import {
  boundedLevenshtein,
  levenshtein,
  similarity,
} from "../src/levenshtein.js";
import { mulberry32, randomInt, randomString } from "./helpers.js";

test("identical strings have distance 0 and similarity 1", () => {
  assert.equal(levenshtein("abcdefghij", "abcdefghij"), 0);
  assert.equal(similarity("abcdefghij", "abcdefghij"), 1);
});

test("single substitution, insertion and deletion each cost one", () => {
  assert.equal(levenshtein("abcdefghij", "abxdefghij"), 1);
  assert.equal(levenshtein("abcdefghij", "abcdefghikj"), 1);
  assert.equal(levenshtein("abcdefghij", "abcdefghj"), 1);
  assert.ok(Math.abs(similarity("abcdefghij", "abxdefghij") - 0.9) < 1e-12);
});

test("adjacent transposition is two unit operations, not one", () => {
  assert.equal(levenshtein("ab", "ba"), 2);
  assert.equal(levenshtein("abcd", "abdc"), 2);
  assert.equal(similarity("ab", "ba"), 0);
});

test("similarity uses the maximum length as denominator", () => {
  assert.equal(similarity("abcd", "abcde"), 1 - 1 / 5);
  assert.equal(similarity("aaaaaaaa", "aaaaaaaaa"), 1 - 1 / 9);
});

test("threshold boundary: 10*d <= maxLen is the exact cutoff", () => {
  const base = "aaaaaaaaaa"; // length 10
  const oneSub = "baaaaaaaaa"; // d = 1 -> similar (10 <= 10)
  const twoSubs = "bbaaaaaaaa"; // d = 2 -> not similar (20 > 10)
  assert.ok(similarity(base, oneSub) >= 0.9);
  assert.ok(similarity(base, twoSubs) < 0.9);
  const len9 = "aaaaaaaaa";
  const len9sub = "baaaaaaaa"; // d = 1, maxLen 9 -> 10 > 9
  assert.ok(similarity(len9, len9sub) < 0.9);
});

test("boundedLevenshtein agrees with exact distance around the bound", () => {
  const rng = mulberry32(12345);
  for (let iter = 0; iter < 500; iter++) {
    const a = randomString(rng, randomInt(rng, 1, 32));
    const b = randomString(rng, randomInt(rng, 1, 32));
    const exact = levenshtein(a, b);
    for (let k = 0; k <= 4; k++) {
      const bounded = boundedLevenshtein(a, b, k);
      if (exact <= k) {
        assert.equal(bounded, exact, `a=${a} b=${b} k=${k}`);
      } else {
        assert.ok(bounded > k, `a=${a} b=${b} k=${k}`);
      }
    }
  }
});

test("boundedLevenshtein handles near neighbours with edits", () => {
  const rng = mulberry32(777);
  for (let iter = 0; iter < 300; iter++) {
    const a = randomString(rng, randomInt(rng, 8, 32));
    const chars = a.split("");
    const edits = randomInt(rng, 1, 3);
    for (let e = 0; e < edits; e++) {
      const op = randomInt(rng, 0, 2);
      const pos = randomInt(rng, 0, chars.length - 1);
      const ch = String.fromCharCode(97 + randomInt(rng, 0, 25));
      if (op === 0) chars[pos] = ch;
      else if (op === 1) chars.splice(pos, 0, ch);
      else if (chars.length > 1) chars.splice(pos, 1);
    }
    const b = chars.join("");
    const exact = levenshtein(a, b);
    for (let k = 0; k <= 4; k++) {
      const bounded = boundedLevenshtein(a, b, k);
      if (exact <= k) assert.equal(bounded, exact);
      else assert.ok(bounded > k);
    }
  }
});
