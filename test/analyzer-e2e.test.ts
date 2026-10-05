import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { StlAnalyzer, MAX_FILE_BYTES } from "../src/index.js";
import {
  buildBinaryStl,
  singleBytes,
  randomChunks,
  allChunkings,
  analyze,
  type Triangle,
} from "./helpers.js";

const enc = new TextEncoder();

function sha256hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

const TRIS: Triangle[] = [
  { normal: [0, 0, 1], vertices: [[0, 0, 0], [25.4, 0, 0], [0, 12.7, 0]] },
  { normal: [0, 0, -1], vertices: [[-2.54, 1, -5.08], [50.8, 2, 3], [1, 2, 7.62]] },
];

test("binary: metadata identical across whole/1-byte/random chunkings", () => {
  const data = buildBinaryStl(TRIS);
  const expected = {
    format: "binary",
    triangleCount: 2,
    sha256: sha256hex(data),
  };
  for (const chunks of allChunkings(data, 42)) {
    const r = analyze(chunks);
    assert.ok(r.ok);
    assert.equal(r.metadata.format, expected.format);
    assert.equal(r.metadata.triangleCount, expected.triangleCount);
    assert.equal(r.metadata.sha256, expected.sha256);
    const f = Math.fround;
    assert.deepEqual(r.metadata.boundingBox, {
      min: { x: f(-2.54) / 25.4, y: 0, z: f(-5.08) / 25.4 },
      max: { x: f(50.8) / 25.4, y: f(12.7) / 25.4, z: f(7.62) / 25.4 },
    });
    assert.deepEqual(r.metadata.size, {
      x: (f(50.8) - f(-2.54)) / 25.4,
      y: f(12.7) / 25.4,
      z: (f(7.62) - f(-5.08)) / 25.4,
    });
  }
});

test("binary: header starting with 'solid' handled as binary", () => {
  const header = enc.encode("solid not actually ascii, binary follows........");
  const data = buildBinaryStl(TRIS, header);
  for (const chunks of allChunkings(data, 5)) {
    const r = analyze(chunks);
    assert.ok(r.ok);
    assert.equal(r.metadata.format, "binary");
    assert.equal(r.metadata.triangleCount, 2);
  }
});

test("binary: zero triangles -> null bbox and size", () => {
  const data = buildBinaryStl([]);
  const r = analyze([data]);
  assert.ok(r.ok);
  assert.equal(r.metadata.triangleCount, 0);
  assert.equal(r.metadata.boundingBox, null);
  assert.equal(r.metadata.size, null);
});

const ASCII_ONE = `solid t
facet normal 0 0 1
outer loop
vertex 0 0 0
vertex 25.4 0 0
vertex 0 12.7 0
endloop
endfacet
endsolid t
`;

test("ascii: metadata identical across chunkings", () => {
  const data = enc.encode(ASCII_ONE);
  for (const chunks of allChunkings(data, 11)) {
    const r = analyze(chunks);
    assert.ok(r.ok);
    assert.equal(r.metadata.format, "ascii");
    assert.equal(r.metadata.triangleCount, 1);
    assert.equal(r.metadata.sha256, sha256hex(data));
    assert.deepEqual(r.metadata.boundingBox, {
      min: { x: 0, y: 0, z: 0 },
      max: { x: 1, y: 0.5, z: 0 },
    });
    assert.deepEqual(r.metadata.size, { x: 1, y: 0.5, z: 0 });
  }
});

test("ascii: zero facets -> null bbox and size", () => {
  const r = analyze([enc.encode("solid e\nendsolid\n")]);
  assert.ok(r.ok);
  assert.equal(r.metadata.triangleCount, 0);
  assert.equal(r.metadata.boundingBox, null);
  assert.equal(r.metadata.size, null);
});

test("binary preferred when both formats valid", () => {
  // 84 bytes: valid binary (count=0) and valid ascii (endsolid name to EOF).
  const data = new Uint8Array(84);
  data.set(enc.encode("solid\nendsolid "), 0);
  // bytes 80..83 are zero -> binary count 0, length 84 -> valid binary.
  const r = analyze([data]);
  assert.ok(r.ok);
  assert.equal(r.metadata.format, "binary");
  assert.equal(r.metadata.triangleCount, 0);
});

test("invalid inputs: identical error across chunkings", () => {
  const good = buildBinaryStl(TRIS);
  const cases: Uint8Array[] = [
    good.subarray(0, good.length - 1), // truncated
    Uint8Array.from([...good, 0]), // trailing byte
    enc.encode("this is not stl at all\n"),
    enc.encode("solid a\nfacet normal 0 0 1\n"), // truncated ascii
    enc.encode("solid a\nendfacet\nendsolid\n"), // bad keyword
    new Uint8Array(0), // empty
  ];
  for (const data of cases) {
    const results = allChunkings(data, 3).map((chunks) => analyze(chunks));
    for (const r of results) {
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.error.code, "FORMAT_ERROR");
    }
  }
});

test("non-finite binary component -> format error, no partial metadata", () => {
  const tri: Triangle = { normal: [0, 0, 1], vertices: [[0, 0, 0], [NaN, 0, 0], [0, 1, 0]] };
  const data = buildBinaryStl([tri]);
  for (const chunks of allChunkings(data, 8)) {
    const r = analyze(chunks);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, "FORMAT_ERROR");
  }
});

test("size limit enforced", () => {
  assert.equal(MAX_FILE_BYTES, 500 * 1024 * 1024);
  const a = new StlAnalyzer({ maxFileBytes: 100 });
  a.push(new Uint8Array(60));
  a.push(new Uint8Array(41));
  const r = a.finish();
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.code, "SIZE_LIMIT_EXCEEDED");
  // exactly at the limit is fine
  const b = new StlAnalyzer({ maxFileBytes: 100 });
  b.push(new Uint8Array(100));
  b.finish(); // format error but not size error
  const rb = b.finish();
  assert.equal(rb.ok, false);
  if (!rb.ok) assert.equal(rb.error.code, "FORMAT_ERROR");
});

test("push after finish throws", () => {
  const a = new StlAnalyzer();
  a.finish();
  assert.throws(() => a.push(new Uint8Array(1)));
});
