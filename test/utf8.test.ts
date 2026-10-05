import { test } from "node:test";
import assert from "node:assert/strict";
import { Utf8Validator } from "../src/utf8.js";

function valid(bytes: number[] | Uint8Array, chunkSize = Infinity): boolean {
  const v = new Utf8Validator();
  const arr = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  for (let off = 0; off < arr.length; off += chunkSize) {
    if (!v.push(arr.subarray(off, Math.min(off + chunkSize, arr.length)))) return false;
  }
  return v.isComplete();
}

test("valid utf8 incl. multibyte split across chunks", () => {
  const s = "solid námé € 𝄞 中文\tendsolid";
  const bytes = new TextEncoder().encode(s);
  for (const cs of [1, 2, 3, Infinity]) {
    assert.ok(valid(bytes, cs), `chunkSize=${cs}`);
  }
});

test("invalid utf8 sequences rejected", () => {
  assert.ok(!valid([0xc0, 0xaf])); // overlong
  assert.ok(!valid([0xed, 0xa0, 0x80])); // surrogate
  assert.ok(!valid([0xf4, 0x90, 0x80, 0x80])); // > U+10FFFF
  assert.ok(!valid([0x80])); // stray continuation
  assert.ok(!valid([0xc2])); // dangling prefix (incomplete)
  assert.ok(!valid([0xe4, 0xb8])); // truncated 3-byte
});

test("invalid detected mid-stream with 1-byte chunks", () => {
  const bytes = Uint8Array.from([0x61, 0x62, 0xed, 0xa0, 0x80, 0x63]);
  assert.ok(!valid(bytes, 1));
});
