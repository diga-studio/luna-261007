import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { StlAnalyzer } from "../src/index.js";
import { analyze, singleBytes, randomChunks } from "./helpers.js";

const enc = new TextEncoder();

test("multi-solid ascii: utf8 names, exponents, far normals; corrupted tail invalidates all", () => {
  const name1 = "名称αβ𝄞-第一块";
  const name2 = "别的名字€xyz";
  const tri = (z: number) => `facet normal 1e30 -2.5e25 9e99
outer loop
vertex 0 0 ${z}
vertex 25.4 0 ${z}
vertex 0 12.7e0 ${z}
endloop
endfacet
`;
  const good =
    `solid ${name1}\n${tri(0)}${tri(2.54)}endsolid ${name1}\n` +
    `solid ${name2}\n${tri(-5.08)}endsolid ${name2}\n`;
  const goodBytes = enc.encode(good);

  // Valid version: consistent across chunkings (1-byte chunks split UTF-8).
  for (const chunks of [[goodBytes], singleBytes(goodBytes), randomChunks(goodBytes, 77)]) {
    const r = analyze(chunks);
    assert.ok(r.ok);
    assert.equal(r.metadata.format, "ascii");
    assert.equal(r.metadata.triangleCount, 3);
    // normals (1e30 etc.) must not leak into the bbox
    assert.deepEqual(r.metadata.boundingBox, {
      min: { x: 0, y: 0, z: -0.2 },
      max: { x: 1, y: 0.5, z: 0.1 },
    });
    assert.deepEqual(r.metadata.size, { x: 1, y: 0.5, z: 0.30000000000000004 });
  }

  // Corrupt the final keyword: whole file must fail, no early bbox.
  const bad = good.replace(/endsolid(?!.*endsolid)/s, "endsolix");
  assert.notEqual(bad, good);
  const badBytes = enc.encode(bad);
  for (const chunks of [[badBytes], singleBytes(badBytes), randomChunks(badBytes, 78)]) {
    const r = analyze(chunks);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error.code, "FORMAT_ERROR");
      assert.equal((r as Record<string, unknown>).metadata, undefined);
    }
  }
});

test("bounded memory: lazy 64 MiB+ name and many repeated triangles", () => {
  const NAME_BYTES = 64 * 1024 * 1024;
  const FACETS = 300_000;
  const CHUNK = 65536;

  // Lazily produce the file; the full input is never materialized.
  function* generate(): Generator<Uint8Array, void, undefined> {
    let pending = new Uint8Array(0);
    function* emit(bytes: Uint8Array): Generator<Uint8Array, void, undefined> {
      const merged = new Uint8Array(pending.length + bytes.length);
      merged.set(pending, 0);
      merged.set(bytes, pending.length);
      let off = 0;
      while (merged.length - off >= CHUNK) {
        yield merged.subarray(off, off + CHUNK);
        off += CHUNK;
      }
      pending = merged.subarray(off);
    }
    yield* emit(enc.encode("solid "));
    // 64 MiB+ of name with multibyte UTF-8 (chunks split sequences).
    const pattern = enc.encode("abcdefg中文𝄞xyz");
    let produced = 0;
    while (produced < NAME_BYTES) {
      yield* emit(pattern);
      produced += pattern.length;
    }
    yield* emit(enc.encode("\n"));
    const facet = enc.encode(
      "facet normal 1e30 0 -1e30\nouter loop\n" +
        "vertex 0 0 0\nvertex 25.4 0 0\nvertex 0 25.4 0\nendloop\nendfacet\n",
    );
    for (let i = 0; i < FACETS; i++) yield* emit(facet);
    yield* emit(enc.encode("endsolid same-name-not-required\n"));
    if (pending.length > 0) yield pending;
  }

  const gc = (globalThis as { gc?: () => void }).gc;
  gc?.();
  const heapBefore = process.memoryUsage().heapUsed;

  const analyzer = new StlAnalyzer();
  const ref = createHash("sha256");
  let totalBytes = 0;
  for (const chunk of generate()) {
    totalBytes += chunk.length;
    ref.update(chunk);
    analyzer.push(chunk);
  }
  const r = analyzer.finish();

  gc?.();
  const heapAfter = process.memoryUsage().heapUsed;

  assert.ok(totalBytes > 64 * 1024 * 1024, `streamed ${totalBytes} bytes`);
  assert.ok(r.ok);
  assert.equal(r.metadata.format, "ascii");
  assert.equal(r.metadata.triangleCount, FACETS);
  assert.equal(r.metadata.sha256, ref.digest("hex"));
  assert.deepEqual(r.metadata.boundingBox, {
    min: { x: 0, y: 0, z: 0 },
    max: { x: 1, y: 1, z: 0 },
  });
  assert.deepEqual(r.metadata.size, { x: 1, y: 1, z: 0 });

  // Hard bound: analyzer working memory stays tiny despite ~100 MiB input.
  const growth = heapAfter - heapBefore;
  assert.ok(
    growth < 32 * 1024 * 1024,
    `heap grew by ${(growth / 1024 / 1024).toFixed(1)} MiB`,
  );
});
