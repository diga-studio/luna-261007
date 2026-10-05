import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Sha256 } from "../src/sha256.js";

function ref(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

test("sha256 known vectors", () => {
  const enc = new TextEncoder();
  for (const msg of ["", "abc", "hello world", "a".repeat(1000)]) {
    const h = new Sha256();
    h.update(enc.encode(msg));
    assert.equal(h.digestHex(), ref(enc.encode(msg)));
  }
});

test("sha256 split invariance", () => {
  const data = new Uint8Array(100000);
  for (let i = 0; i < data.length; i++) data[i] = (i * 31 + 7) & 0xff;
  for (const chunkSize of [1, 3, 63, 64, 65, 1000, 100000]) {
    const h = new Sha256();
    for (let off = 0; off < data.length; off += chunkSize) {
      h.update(data.subarray(off, Math.min(off + chunkSize, data.length)));
    }
    assert.equal(h.digestHex(), ref(data), `chunkSize=${chunkSize}`);
  }
});
