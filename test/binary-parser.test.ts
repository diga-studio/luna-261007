import { test } from "node:test";
import assert from "node:assert/strict";
import { BinaryStlParser } from "../src/binary-parser.js";
import { buildBinaryStl, singleBytes, randomChunks, type Triangle } from "./helpers.js";

const TRIS: Triangle[] = [
  { normal: [0, 0, 1], vertices: [[0, 0, 0], [25.4, 0, 0], [0, 12.7, 0]] },
  { normal: [0, 0, -1], vertices: [[-5, -5, -5], [50.8, 2, 3], [1, 2, 7.62]] },
];

function run(data: Uint8Array, chunks: Uint8Array[]) {
  const p = new BinaryStlParser();
  for (const c of chunks) p.push(c);
  p.finish();
  return p.result();
}

test("valid binary parsed identically across chunkings", () => {
  const data = buildBinaryStl(TRIS);
  for (const chunks of [[data], singleBytes(data), randomChunks(data, 7)]) {
    const r = run(data, chunks);
    assert.equal(r.status, "done");
    assert.equal(r.triangleCount, 2);
    assert.deepEqual(r.bboxMin, [-5, -5, -5]);
    assert.deepEqual(r.bboxMax, [Math.fround(50.8), Math.fround(12.7), Math.fround(7.62)]);
  }
});

test("zero triangles is valid with empty bbox", () => {
  const data = buildBinaryStl([]);
  const p = new BinaryStlParser();
  p.push(data);
  p.finish();
  const r = p.result();
  assert.equal(r.status, "done");
  assert.equal(r.triangleCount, 0);
});

test("header starting with 'solid' still parses as binary", () => {
  const header = new TextEncoder().encode("solid this is a binary header, not ascii");
  const data = buildBinaryStl(TRIS, header);
  const p = new BinaryStlParser();
  for (const c of singleBytes(data)) p.push(c);
  p.finish();
  assert.equal(p.result().status, "done");
  assert.equal(p.result().triangleCount, 2);
});

test("truncated file is invalid", () => {
  const data = buildBinaryStl(TRIS);
  for (const cut of [10, 83, 84, 100, data.length - 1]) {
    const p = new BinaryStlParser();
    p.push(data.subarray(0, cut));
    p.finish();
    assert.equal(p.result().status, "invalid", `cut=${cut}`);
  }
});

test("trailing bytes are invalid", () => {
  const data = buildBinaryStl(TRIS);
  const extra = new Uint8Array(data.length + 1);
  extra.set(data);
  const p = new BinaryStlParser();
  p.push(extra);
  p.finish();
  assert.equal(p.result().status, "invalid");
});

test("non-finite components are invalid", () => {
  for (const bad of [NaN, Infinity, -Infinity]) {
    const tri: Triangle = { normal: [0, 0, 1], vertices: [[bad, 0, 0], [1, 0, 0], [0, 1, 0]] };
    const data = buildBinaryStl([tri]);
    const p = new BinaryStlParser();
    p.push(data);
    p.finish();
    assert.equal(p.result().status, "invalid", `bad=${bad}`);
  }
  // non-finite normal also invalid
  const tri: Triangle = { normal: [NaN, 0, 1], vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]] };
  const p = new BinaryStlParser();
  p.push(buildBinaryStl([tri]));
  p.finish();
  assert.equal(p.result().status, "invalid");
});

test("declared count mismatch is invalid", () => {
  const data = buildBinaryStl(TRIS, undefined, 5); // declares 5, has 2
  const p = new BinaryStlParser();
  p.push(data);
  p.finish();
  assert.equal(p.result().status, "invalid");
});
