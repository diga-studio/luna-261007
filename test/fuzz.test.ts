import { test } from "node:test";
import assert from "node:assert/strict";
import { SignatureRuleSet } from "../src/index.js";
import { refMatch } from "./helpers.js";

/** Deterministic PRNG (mulberry32) for reproducible fuzz runs. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rand: () => number, items: T[]): T {
  return items[Math.floor(rand() * items.length)];
}

/** Render a byte as a pattern fragment matching exactly that byte. */
function byteFragment(b: number): string {
  if (b >= 0x21 && b <= 0x7e && !"\\.^$|?*+()[]-".includes(String.fromCharCode(b))) {
    return String.fromCharCode(b);
  }
  return `\\x${b.toString(16).padStart(2, "0")}`;
}

const ALPHABET = [0x61, 0x62, 0x63, 0x00, 0x0a, 0x20, 0x80, 0xff];

function genClass(rand: () => number): string {
  const negated = rand() < 0.3;
  const items: string[] = [];
  const count = 1 + Math.floor(rand() * 3);
  for (let i = 0; i < count; i++) {
    if (rand() < 0.5) {
      const lo = pick(rand, ALPHABET);
      const hi = Math.min(255, lo + Math.floor(rand() * 8));
      items.push(`${byteFragment(lo)}-${byteFragment(hi)}`);
    } else {
      items.push(byteFragment(pick(rand, ALPHABET)));
    }
  }
  return `[${negated ? "^" : ""}${items.join("")}]`;
}

function genAtom(rand: () => number, depth: number): string {
  const r = rand();
  if (depth > 0 && r < 0.25) return `(${genAlt(rand, depth - 1)})`;
  if (r < 0.4) return genClass(rand);
  if (r < 0.55) return ".";
  if (r < 0.62) return "^";
  if (r < 0.69) return "$";
  return byteFragment(pick(rand, ALPHABET));
}

function genRepeat(rand: () => number, depth: number): string {
  const atom = genAtom(rand, depth);
  if (atom === "^" || atom === "$") return atom;
  const r = rand();
  if (r < 0.2) return `${atom}*`;
  if (r < 0.35) return `${atom}+`;
  if (r < 0.45) return `${atom}?`;
  return atom;
}

function genConcat(rand: () => number, depth: number): string {
  const count = Math.floor(rand() * 4);
  let out = "";
  for (let i = 0; i < count; i++) out += genRepeat(rand, depth);
  return out;
}

function genAlt(rand: () => number, depth: number): string {
  const count = 1 + Math.floor(rand() * 3);
  const branches: string[] = [];
  for (let i = 0; i < count; i++) branches.push(genConcat(rand, depth));
  return branches.join("|");
}

function genBody(rand: () => number): Uint8Array {
  const len = Math.floor(rand() * 13);
  const body = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    body[i] = rand() < 0.7 ? pick(rand, ALPHABET) : Math.floor(rand() * 256);
  }
  return body;
}

/** Split a body into random chunks, sometimes inserting empty chunks. */
function genChunks(rand: () => number, body: Uint8Array): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  let pos = 0;
  while (pos < body.length) {
    if (rand() < 0.15) chunks.push(new Uint8Array(0));
    const take = 1 + Math.floor(rand() * (body.length - pos));
    chunks.push(body.slice(pos, pos + take));
    pos += take;
  }
  if (rand() < 0.3) chunks.push(new Uint8Array(0));
  return chunks;
}

test("differential fuzz: hit sets match RegExp oracle under random chunking", () => {
  const ITERATIONS = 2000;
  for (let iter = 0; iter < ITERATIONS; iter++) {
    const rand = rng(iter * 2654435761 + 1);
    const pattern = genAlt(rand, 2);
    const body = genBody(rand);

    // Validate the generated pattern parses in our engine.
    const set = new SignatureRuleSet();
    set.addRule({ id: "r", pattern });

    const expected = refMatch(pattern, body);

    // Whole body in one chunk.
    const d1 = set.createDetection();
    d1.push(body);
    assert.equal(
      d1.end().includes("r"),
      expected,
      `whole-body mismatch: pattern=${JSON.stringify(pattern)} body=[${[...body]}]`,
    );

    // Random chunking must give the same answer.
    const d2 = set.createDetection();
    for (const chunk of genChunks(rand, body)) d2.push(chunk);
    assert.equal(
      d2.end().includes("r"),
      expected,
      `chunked mismatch: pattern=${JSON.stringify(pattern)} body=[${[...body]}]`,
    );
  }
});

test("differential fuzz: multiple rules share one detection", () => {
  const ITERATIONS = 500;
  for (let iter = 0; iter < ITERATIONS; iter++) {
    const rand = rng(iter * 40503 + 7);
    const patterns = [genAlt(rand, 2), genAlt(rand, 2), genAlt(rand, 2)];
    const body = genBody(rand);

    const set = new SignatureRuleSet();
    patterns.forEach((p, i) => set.addRule({ id: `r${i}`, pattern: p }));

    const d = set.createDetection();
    for (const chunk of genChunks(rand, body)) d.push(chunk);
    const hits = new Set(d.end());

    const expected = new Set(
      patterns.map((p, i) => [`r${i}`, p] as const).filter(([, p]) => refMatch(p, body)).map(([id]) => id),
    );
    assert.deepEqual(
      hits,
      expected,
      `patterns=${JSON.stringify(patterns)} body=[${[...body]}]`,
    );
  }
});
