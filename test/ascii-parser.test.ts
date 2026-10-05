import { test } from "node:test";
import assert from "node:assert/strict";
import { AsciiStlParser } from "../src/ascii-parser.js";
import { singleBytes, randomChunks } from "./helpers.js";

const enc = new TextEncoder();

function run(text: string | Uint8Array, chunks?: Uint8Array[]) {
  const data = typeof text === "string" ? enc.encode(text) : text;
  const p = new AsciiStlParser();
  for (const c of chunks ?? [data]) p.push(c);
  p.finish();
  return p.result();
}

const ONE_TRI = `solid test
facet normal 0 0 1
outer loop
vertex 0 0 0
vertex 25.4 0 0
vertex 0 12.7 0
endloop
endfacet
endsolid test
`;

test("single triangle, consistent across chunkings", () => {
  const data = enc.encode(ONE_TRI);
  for (const chunks of [[data], singleBytes(data), randomChunks(data, 99)]) {
    const r = run(data, chunks);
    assert.equal(r.status, "done");
    assert.equal(r.triangleCount, 1);
    assert.deepEqual(r.bboxMin, [0, 0, 0]);
    assert.deepEqual(r.bboxMax, [25.4, 12.7, 0]);
  }
});

test("crlf line endings and no trailing newline", () => {
  const text = ONE_TRI.replace(/\n/g, "\r\n").replace(/\r\n$/, "");
  const r = run(text);
  assert.equal(r.status, "done");
  assert.equal(r.triangleCount, 1);
});

test("exponents, signs, fractions", () => {
  const text = `solid
facet normal 0e0 0.0 +1.
outer loop
vertex -1.5e1 +2.5E-1 .5
vertex 1e1 2 3
vertex 4 5 6e+0
endloop
endfacet
endsolid`;
  const r = run(text);
  assert.equal(r.status, "done");
  assert.deepEqual(r.bboxMin, [-15, 0.25, 0.5]);
  assert.deepEqual(r.bboxMax, [10, 5, 6]);
});

test("zero facets is valid, empty bbox", () => {
  const r = run("solid empty\nendsolid\n");
  assert.equal(r.status, "done");
  assert.equal(r.triangleCount, 0);
});

test("multiple solid blocks", () => {
  const tri = `facet normal 0 0 1
outer loop
vertex 0 0 0
vertex 1 0 0
vertex 0 1 0
endloop
endfacet
`;
  const r = run(`solid a\n${tri}endsolid a\nsolid b\n${tri}${tri}endsolid b\n`);
  assert.equal(r.status, "done");
  assert.equal(r.triangleCount, 3);
});

test("utf8 names incl. multibyte split across 1-byte chunks", () => {
  const text = "solid námé € 中文 𝄞\nendsolid námé € 中文 𝄞\n";
  const data = enc.encode(text);
  const r = run(data, singleBytes(data));
  assert.equal(r.status, "done");
});

test("invalid utf8 in name rejected", () => {
  const data = Uint8Array.from([...enc.encode("solid "), 0xed, 0xa0, 0x80, ...enc.encode("\nendsolid\n")]);
  const r = run(data, singleBytes(data));
  assert.equal(r.status, "invalid");
});

test("uppercase keywords rejected", () => {
  assert.equal(run(ONE_TRI.replace("facet", "Facet")).status, "invalid");
  assert.equal(run(ONE_TRI.replace("solid test", "SOLID test")).status, "invalid");
});

test("structure violations rejected", () => {
  assert.equal(run("solid\nendsolid extra\n").status, "done"); // name ok
  assert.equal(run("solid a\nouter loop\nendsolid\n").status, "invalid");
  assert.equal(run(ONE_TRI.replace("outer loop", "outer")).status, "invalid");
  assert.equal(run(ONE_TRI.replace("endloop", "")).status, "invalid");
  assert.equal(run(ONE_TRI.replace("vertex 0 12.7 0", "vertex 0 0")).status, "invalid");
  assert.equal(run("").status, "invalid");
  assert.equal(run("solid only\n").status, "invalid"); // missing endsolid
});

test("non-finite and oversized number tokens rejected", () => {
  const base = ONE_TRI;
  assert.equal(run(base.replace("25.4", "1e999")).status, "invalid"); // Infinity
  assert.equal(run(base.replace("25.4", "nan")).status, "invalid");
  assert.equal(run(base.replace("25.4", "inf")).status, "invalid");
  assert.equal(run(base.replace("25.4", "0x10")).status, "invalid");
  assert.equal(run(base.replace("25.4", "1".repeat(65))).status, "invalid"); // >64 bytes
  assert.equal(run(base.replace("25.4", "1.2.3")).status, "invalid");
  assert.equal(run(base.replace("25.4", "1e")).status, "invalid");
});

test("endsolid must start its own line", () => {
  const text = "solid a\nendfacet-ish\nendsolid\n";
  assert.equal(run(text).status, "invalid");
  // 'endsolid' not at line start:
  const t2 = "solid a\nfacet normal 0 0 1 outer loop vertex 0 0 0 vertex 1 0 0 vertex 0 1 0 endloop endfacet endsolid\n";
  assert.equal(run(t2).status, "invalid");
});

test("geometry tokens may share one line", () => {
  const text = "solid a\nfacet normal 0 0 1 outer loop vertex 0 0 0 vertex 1 0 0 vertex 0 1 0 endloop endfacet\nendsolid\n";
  const r = run(text);
  assert.equal(r.status, "done");
  assert.equal(r.triangleCount, 1);
});
