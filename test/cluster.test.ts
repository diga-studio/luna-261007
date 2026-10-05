import assert from "node:assert/strict";
import { test } from "node:test";
import { cluster } from "../src/cluster.js";
import { similarity } from "../src/levenshtein.js";
import type { DedupRecord } from "../src/types.js";
import {
  bruteForceClusters,
  canonicalClusters,
  mulberry32,
  randomInt,
  randomString,
  shuffle,
} from "./helpers.js";

test("similarity chain merges transitively even when endpoints differ", () => {
  const a = "abcdefghij";
  const b = "abxdefghij";
  const c = "abxyefghij";
  assert.ok(similarity(a, b) >= 0.9);
  assert.ok(similarity(b, c) >= 0.9);
  assert.ok(similarity(a, c) < 0.9, "endpoints must not be directly similar");

  const records: DedupRecord[] = [
    { id: "a1", value: a },
    { id: "b1", value: b },
    { id: "c1", value: c },
    { id: "a2", value: a }, // same value, different id
    { id: "c2", value: c },
    { id: "lonely", value: "zzzzzzzzzzzz" },
  ];
  const expected = canonicalClusters([
    { ids: ["a1", "a2", "b1", "c1", "c2"] },
  ]);
  const rng = mulberry32(999);
  for (let trial = 0; trial < 25; trial++) {
    const shuffled = shuffle(rng, [...records]);
    const result = cluster(shuffled);
    assert.equal(
      canonicalClusters(result.clusters),
      expected,
      `trial ${trial}: membership must not depend on input order`,
    );
  }
});

test("pairs exactly at and just past the threshold boundary", () => {
  const records: DedupRecord[] = [
    { id: "base10", value: "aaaaaaaaaa" },
    { id: "sub1", value: "baaaaaaaaa" }, // d=1, 10*1 <= 10 -> match
    { id: "base10b", value: "cccccccccc" },
    { id: "sub2", value: "ddcccccccc" }, // d=2, 10*2 > 10 -> no match
    { id: "base20", value: "eeeeeeeeeeeeeeeeeeee" },
    { id: "sub20ok", value: "ffeeeeeeeeeeeeeeeeee" }, // d=2, 20 <= 20 -> match
    { id: "base20b", value: "gggggggggggggggggggg" },
    { id: "sub20bad", value: "hhhggggggggggggggggg" }, // d=3, 30 > 20 -> no
    { id: "len9", value: "iiiiiiiii" },
    { id: "len9sub", value: "jiiiiiiii" }, // d=1, 10 > 9 -> no match
    { id: "len11", value: "kkkkkkkkkkk" },
    { id: "len11sub", value: "lkkkkkkkkkk" }, // d=1, 10 <= 11 -> match
  ];
  const result = cluster(records);
  assert.equal(
    canonicalClusters(result.clusters),
    canonicalClusters([
      { ids: ["base10", "sub1"] },
      { ids: ["base20", "sub20ok"] },
      { ids: ["len11", "len11sub"] },
    ]),
  );
});

function generateMixedRecords(seed: number, count: number): DedupRecord[] {
  const rng = mulberry32(seed);
  const records: DedupRecord[] = [];
  const push = (value: string) => {
    records.push({ id: `id${records.length}`, value });
  };
  while (records.length < count) {
    const kind = randomInt(rng, 0, 6);
    if (kind === 0 || records.length === 0) {
      // Fresh random value, sometimes highly repetitive.
      if (randomInt(rng, 0, 3) === 0) {
        const ch = String.fromCharCode(97 + randomInt(rng, 0, 25));
        push(ch.repeat(randomInt(rng, 8, 32)));
      } else {
        push(randomString(rng, randomInt(rng, 8, 32)));
      }
    } else if (kind === 1) {
      // Exact duplicate of an existing value under a new id.
      const src = records[randomInt(rng, 0, records.length - 1)].value;
      push(src);
    } else if (kind === 2) {
      // Near neighbour via 1-3 random edits (sub / ins / del).
      const src = records[randomInt(rng, 0, records.length - 1)].value;
      const chars = src.split("");
      const edits = randomInt(rng, 1, 3);
      for (let e = 0; e < edits; e++) {
        const op = randomInt(rng, 0, 2);
        const pos = randomInt(rng, 0, chars.length - 1);
        const ch = String.fromCharCode(97 + randomInt(rng, 0, 25));
        if (op === 0) chars[pos] = ch;
        else if (op === 1 && chars.length < 32) chars.splice(pos, 0, ch);
        else if (chars.length > 8) chars.splice(pos, 1);
      }
      push(chars.join(""));
    } else if (kind === 3) {
      // Same tail, different first letter (prefix must not drive matching).
      const tail = randomString(rng, randomInt(rng, 7, 31));
      push(`a${tail}`);
      push(`b${tail}`);
    } else if (kind === 4) {
      // Lengths straddling the threshold: d edits on a length-10k base.
      const unit = randomInt(rng, 1, 3);
      const len = 10 * unit;
      const base = randomString(rng, len);
      push(base);
      const okChars = base.split("");
      for (let e = 0; e < unit; e++) {
        okChars[randomInt(rng, 0, len - 1)] = String.fromCharCode(
          97 + randomInt(rng, 0, 25),
        );
      }
      push(okChars.join("")); // d <= unit -> 10*d <= len -> match
      const badChars = base.split("");
      for (let e = 0; e < unit + 1; e++) {
        badChars[e] = String.fromCharCode(
          97 + ((base.charCodeAt(e) - 96) % 26),
        );
      }
      push(badChars.join("")); // d = unit+1 -> 10*d > len -> no match
    } else if (kind === 5) {
      // Repeated-alphabet strings (many shared grams).
      const len = randomInt(rng, 8, 32);
      let value = "";
      for (let i = 0; i < len; i++) {
        value += String.fromCharCode(97 + (i % randomInt(rng, 1, 4)));
      }
      push(value);
    } else {
      // Length-8/9 values: only exact duplicates can ever match.
      push(randomString(rng, randomInt(rng, 8, 9)));
    }
  }
  return records;
}

test("random seeded inputs match the exhaustive reference", () => {
  const seeds = [1, 2, 3, 4, 5, 6, 7, 8];
  for (const seed of seeds) {
    const records = generateMixedRecords(seed, 120);
    const expected = canonicalClusters(bruteForceClusters(records));
    const rng = mulberry32(seed * 1000);
    for (let trial = 0; trial < 3; trial++) {
      const shuffled = shuffle(rng, [...records]);
      const result = cluster(shuffled);
      assert.equal(
        canonicalClusters(result.clusters),
        expected,
        `seed ${seed} trial ${trial}`,
      );
    }
  }
});

test("empty and singleton inputs produce no clusters", () => {
  assert.deepEqual(cluster([]), { clusters: [], stats: { distanceChecks: 0 } });
  const single = cluster([{ id: "x", value: "abcdefghij" }]);
  assert.equal(single.clusters.length, 0);
});
