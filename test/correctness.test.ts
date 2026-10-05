import assert from "node:assert/strict";
import test from "node:test";
import { build, type Page, type SynonymEdge } from "../src/index.js";
import { referenceSearch } from "./reference.js";

function page(id: number, fields: Partial<Pick<Page, "title" | "body" | "tags" | "author">>): Page {
  return {
    id,
    title: fields.title ?? [],
    body: fields.body ?? [],
    tags: fields.tags ?? [],
    author: fields.author ?? [],
  };
}

function check(pages: Page[], synonyms: SynonymEdge[], query: string[], k: number): void {
  const expected = referenceSearch(pages, synonyms, query, k);
  const actual = build(pages, synonyms).search(query, k);
  assert.deepEqual(actual, expected, `query=${JSON.stringify(query)} k=${k}`);
}

test("multi-hop path beats low-weight direct edge", () => {
  // a -1000-> c -1000-> b  (b@1000)  vs  a -100-> b  (b@100)
  const pages = [page(1, { body: ["b"] }), page(2, { body: ["c"] })];
  const synonyms: SynonymEdge[] = [
    { from: "a", to: "b", w: 100 },
    { from: "a", to: "c", w: 1000 },
    { from: "c", to: "b", w: 1000 },
  ];
  const hits = build(pages, synonyms).search(["a"], 10);
  // page1: b@1000 * body(1) = 1000; page2: c@1000 * 1 = 1000. Tie -> id asc.
  assert.deepEqual(hits, [
    { id: 1, score: 1000 },
    { id: 2, score: 1000 },
  ]);
  check(pages, synonyms, ["a"], 10);
});

test("weight-1000 cycle keeps confidence without divergence", () => {
  const pages = [page(1, { body: ["b"] }), page(2, { title: ["c"] })];
  const synonyms: SynonymEdge[] = [
    { from: "a", to: "b", w: 1000 },
    { from: "b", to: "a", w: 1000 },
    { from: "b", to: "c", w: 1000 },
  ];
  const hits = build(pages, synonyms).search(["a"], 10);
  assert.deepEqual(hits, [
    { id: 2, score: 8000 }, // c@1000 in title
    { id: 1, score: 1000 }, // b@1000 in body
  ]);
  check(pages, synonyms, ["a"], 10);
});

test("multiple correction starts converge with max confidence", () => {
  // query "abc": vocab "abd","abe" are distance-1 (conf 600 each).
  // abd -500-> xyz (300), abe -1000-> xyz (600): xyz must be 600, not 900.
  const pages = [page(1, { body: ["xyz"] })];
  const synonyms: SynonymEdge[] = [
    { from: "abd", to: "xyz", w: 500 },
    { from: "abe", to: "xyz", w: 1000 },
  ];
  const hits = build(pages, synonyms).search(["abc"], 10);
  assert.deepEqual(hits, [{ id: 1, score: 600 }]);
  check(pages, synonyms, ["abc"], 10);
});

test("non-BMP characters: insertion and substitution by code point", () => {
  const pages = [
    page(1, { body: ["a😀b"] }), // query "a😀b" exact
    page(2, { body: ["a😁b"] }), // substitution of one non-BMP char
    page(3, { body: ["a😀"] }), // deletion of trailing "b"
    page(4, { body: ["ab"] }), // deletion of the emoji
    page(5, { body: ["a😀😀b"] }), // insertion of one emoji
    page(6, { body: ["a😀bc"] }), // distance 1 by insertion of "c"
    page(7, { body: ["😀a😀b"] }), // distance 1 by insertion at front
  ];
  const hits = build(pages, []).search(["a😀b"], 10);
  // exact: 1000; all distance-1 neighbors: 600.
  assert.deepEqual(hits, [
    { id: 1, score: 1000 },
    { id: 2, score: 600 },
    { id: 3, score: 600 },
    { id: 4, score: 600 },
    { id: 5, score: 600 },
    { id: 6, score: 600 },
    { id: 7, score: 600 },
  ]);
  check(pages, [], ["a😀b"], 10);
});

test("field weights and max-not-sum per term", () => {
  const pages = [
    page(1, { title: ["x"], body: ["x", "x", "x"] }), // max(8,1)*1000 = 8000
    page(2, { tags: ["x"], author: ["x"] }),          // max(4,2)*1000 = 4000
    page(3, { body: ["x"] }),                          // 1000
  ];
  const hits = build(pages, []).search(["x"], 10);
  assert.deepEqual(hits, [
    { id: 1, score: 8000 },
    { id: 2, score: 4000 },
    { id: 3, score: 1000 },
  ]);
  check(pages, [], ["x"], 10);
});

test("page must hit every query term; duplicate query tokens deduped", () => {
  const pages = [
    page(1, { body: ["alpha", "beta"] }),
    page(2, { body: ["alpha"] }),
    page(3, { body: ["beta"] }),
  ];
  const hits = build(pages, []).search(["alpha", "beta", "alpha"], 10);
  assert.deepEqual(hits, [{ id: 1, score: 2000 }]);
  check(pages, [], ["alpha", "beta", "alpha"], 10);
});

test("zero-confidence edges are not hits", () => {
  const pages = [page(1, { body: ["beta"] })];
  const synonyms: SynonymEdge[] = [{ from: "alpha", to: "beta", w: 0 }];
  assert.deepEqual(build(pages, synonyms).search(["a"], 10), []);
  check(pages, synonyms, ["alpha"], 10);
});

test("high-frequency + rare term: winners rank beyond 20 in each single-term ranking", () => {
  // 30 pages with "common" in title (score 8000 each) plus unique rare words.
  // The final top hits for [common, rareK] must come from pages whose
  // single-term rank for "common" is > 20 (ties broken by id).
  const pages: Page[] = [];
  for (let i = 1; i <= 30; i++) {
    pages.push(page(i, { title: ["common"], body: [`rare${i}`] }));
  }
  // Pages 25..30 also carry a searchable rare token via a synonym chain.
  const synonyms: SynonymEdge[] = [{ from: "needle", to: "rare27", w: 900 }];
  const r = build(pages, synonyms);
  const hits = r.search(["common", "needle"], 5);
  // Only page 27 hits both terms: common@1000*8 + rare27@900*1.
  assert.deepEqual(hits, [{ id: 27, score: 8900 }]);
  // Sanity: single-term "common" ranking puts page 27 at position 27 (>20).
  const commonOnly = r.search(["common"], 30);
  assert.equal(commonOnly.findIndex((h) => h.id === 27) > 19, true);
  check(pages, synonyms, ["common", "needle"], 5);
});

// Seeded PRNG for reproducible fuzz tests.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("randomized cross-check against brute-force reference", () => {
  const rand = mulberry32(12345);
  const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)]!;
  const vocab: string[] = [];
  const bases = ["ab", "cd", "ef", "gh", "token", "😀x", "w😀", "zz"];
  for (const b of bases) {
    vocab.push(b, b + "1", b + "2", b.slice(0, -1), b + "😀");
  }
  for (let caseNo = 0; caseNo < 30; caseNo++) {
    const pages: Page[] = [];
    const pageCount = 1 + Math.floor(rand() * 12);
    for (let i = 1; i <= pageCount; i++) {
      const tokens = () =>
        Array.from({ length: Math.floor(rand() * 5) }, () => pick(vocab));
      pages.push(
        page(i, { title: tokens(), body: tokens(), tags: tokens(), author: tokens() }),
      );
    }
    const synonyms: SynonymEdge[] = [];
    const edgeCount = Math.floor(rand() * 15);
    for (let i = 0; i < edgeCount; i++) {
      synonyms.push({
        from: pick(vocab),
        to: pick(vocab),
        w: Math.floor(rand() * 1001),
      });
    }
    const query = Array.from({ length: 1 + Math.floor(rand() * 4) }, () => pick(vocab));
    const k = 1 + Math.floor(rand() * 20);
    check(pages, synonyms, query, k);
  }
});
