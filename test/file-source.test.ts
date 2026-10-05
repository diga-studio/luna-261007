import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileContentSource, SecureVault, MAX_CHUNK_BYTES } from "../src/index.js";

test("FileContentSource：经 SecureVault 流式读出完整文件，每块 ≤ 64 KiB", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vault-test-"));
  try {
    const size = 64 * 1024 * 2 + 12345; // 跨三块
    const expected = new Uint8Array(size);
    for (let i = 0; i < size; i++) expected[i] = (i * 31 + 7) & 0xff;
    writeFileSync(join(dir, "doc.bin"), expected);

    const vault = new SecureVault({ source: new FileContentSource(dir) });
    vault.setGrant("u", "doc.bin", { expiresAt: null, maxViews: 1 });
    const token = vault.issueToken("u", "doc.bin");

    const chunks: Uint8Array[] = [];
    for await (const chunk of vault.open("u", token)) {
      assert.ok(chunk.byteLength <= MAX_CHUNK_BYTES, "chunk must not exceed 64 KiB");
      chunks.push(chunk);
    }
    assert.ok(chunks.length >= 3, "file must be streamed in multiple chunks");
    const actual = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    assert.deepEqual(actual, Buffer.from(expected));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FileContentSource：拒绝逃逸 rootDir 的路径", () => {
  const dir = mkdtempSync(join(tmpdir(), "vault-test-"));
  try {
    const source = new FileContentSource(dir);
    assert.throws(() => source.open("../outside"), /escapes rootDir/);
    assert.throws(() => source.open("/etc/passwd"), /escapes rootDir/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
