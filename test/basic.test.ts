import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import {
  TrainingMaterialStore,
  CHUNK_SIZE,
  ChunkConflictError,
  DeclarationConflictError,
  DigestMismatchError,
  IncompleteUploadError,
  InvalidChunkError,
  InvalidDeclarationError,
  NotFoundError,
} from "../src/index.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ingest-basic-"));
}

function sha256(buf: Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** 生成 3.5 MiB 确定性素材（4 个分块：3×1MiB + 0.5MiB）。 */
function makeMaterial(): Buffer {
  const size = 3 * CHUNK_SIZE + CHUNK_SIZE / 2;
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i++) buf[i] = (i * 31 + 7) % 251;
  return buf;
}

const MATERIAL = makeMaterial();
const MATERIAL_SHA = sha256(MATERIAL);
const DECL = {
  uploadId: "video-001",
  totalSize: MATERIAL.length,
  sha256: MATERIAL_SHA,
};

function chunkOf(seq: number): Buffer {
  return MATERIAL.subarray(seq * CHUNK_SIZE, (seq + 1) * CHUNK_SIZE);
}

test("登记幂等；重复登记不清空进度；不同声明报错", () => {
  const dir = tmpDir();
  const store = new TrainingMaterialStore(dir);
  store.registerUpload(DECL);
  store.receiveChunk(DECL.uploadId, 0, chunkOf(0));
  store.registerUpload(DECL); // 重复登记
  store.registerUpload(DECL);
  const st = store.getStatus(DECL.uploadId);
  assert.deepEqual(st.receivedChunks, [0]);
  assert.equal(st.receivedBytes, CHUNK_SIZE);
  assert.equal(st.complete, false);
  assert.throws(
    () =>
      store.registerUpload({ ...DECL, sha256: "0".repeat(64) }),
    DeclarationConflictError,
  );
  assert.throws(
    () => store.registerUpload({ ...DECL, totalSize: 123 }),
    DeclarationConflictError,
  );
  store.close();
});

test("非法声明被拒绝", () => {
  const dir = tmpDir();
  const store = new TrainingMaterialStore(dir);
  assert.throws(
    () => store.registerUpload({ uploadId: "../evil", totalSize: 1, sha256: "a".repeat(64) }),
    InvalidDeclarationError,
  );
  assert.throws(
    () => store.registerUpload({ uploadId: "x", totalSize: 0, sha256: "a".repeat(64) }),
    InvalidDeclarationError,
  );
  assert.throws(
    () =>
      store.registerUpload({
        uploadId: "x",
        totalSize: 100 * 1024 * 1024 + 1,
        sha256: "a".repeat(64),
      }),
    InvalidDeclarationError,
  );
  assert.throws(
    () => store.registerUpload({ uploadId: "x", totalSize: 1, sha256: "zz" }),
    InvalidDeclarationError,
  );
  store.close();
});

test("乱序 + 重复 + 冲突重试后成品逐字节一致", () => {
  const dir = tmpDir();
  const store = new TrainingMaterialStore(dir);
  store.registerUpload(DECL);

  const order = [2, 0, 3, 1];
  for (const seq of order) store.receiveChunk(DECL.uploadId, seq, chunkOf(seq));
  // 重复提交相同内容：幂等成功
  for (const seq of order) store.receiveChunk(DECL.uploadId, seq, chunkOf(seq));
  // 夹入内容冲突的重试：报错且不破坏进度
  for (const seq of order) {
    const evil = Buffer.from(chunkOf(seq));
    evil[0] = (evil[0] ?? 0) ^ 0xff;
    assert.throws(
      () => store.receiveChunk(DECL.uploadId, seq, evil),
      ChunkConflictError,
    );
  }
  let st = store.getStatus(DECL.uploadId);
  assert.deepEqual(st.receivedChunks, [0, 1, 2, 3]);
  assert.equal(st.receivedBytes, MATERIAL.length);

  const r1 = store.finalize(DECL.uploadId);
  assert.ok(fs.existsSync(r1.filePath));
  const product = fs.readFileSync(r1.filePath);
  assert.equal(product.length, MATERIAL.length);
  assert.ok(product.equals(MATERIAL), "product must be byte-identical");

  // 重复完成返回同一位置
  const r2 = store.finalize(DECL.uploadId);
  assert.equal(r2.filePath, r1.filePath);

  // 完成后：相同内容幂等成功，不同内容报错且不改写
  store.receiveChunk(DECL.uploadId, 1, chunkOf(1));
  const evil = Buffer.from(chunkOf(1));
  evil[5] = (evil[5] ?? 0) ^ 0xff;
  assert.throws(
    () => store.receiveChunk(DECL.uploadId, 1, evil),
    ChunkConflictError,
  );
  assert.ok(fs.readFileSync(r1.filePath).equals(MATERIAL));

  st = store.getStatus(DECL.uploadId);
  assert.equal(st.complete, true);
  assert.equal(st.filePath, r1.filePath);
  store.close();
});

test("分块大小与序号校验", () => {
  const dir = tmpDir();
  const store = new TrainingMaterialStore(dir);
  store.registerUpload(DECL);
  assert.throws(
    () => store.receiveChunk(DECL.uploadId, 0, Buffer.alloc(10)),
    InvalidChunkError,
  );
  assert.throws(
    () => store.receiveChunk(DECL.uploadId, 4, chunkOf(0)),
    InvalidChunkError,
  );
  assert.throws(
    () => store.receiveChunk(DECL.uploadId, -1, chunkOf(0)),
    InvalidChunkError,
  );
  // 最后一块必须是剩余长度
  assert.throws(
    () => store.receiveChunk(DECL.uploadId, 3, Buffer.alloc(CHUNK_SIZE)),
    InvalidChunkError,
  );
  store.receiveChunk(DECL.uploadId, 3, chunkOf(3)); // 正确长度成功
  store.close();
});

test("未齐全不能完成；摘要不符不能完成", () => {
  const dir = tmpDir();
  const store = new TrainingMaterialStore(dir);
  store.registerUpload(DECL);
  store.receiveChunk(DECL.uploadId, 0, chunkOf(0));
  assert.throws(() => store.finalize(DECL.uploadId), IncompleteUploadError);

  // 声明错误摘要：收齐后 finalize 报 DigestMismatchError，且不产生成品
  const badDecl = {
    uploadId: "bad-sha",
    totalSize: MATERIAL.length,
    sha256: "f".repeat(64),
  };
  store.registerUpload(badDecl);
  for (let s = 0; s < 4; s++) {
    store.receiveChunk(badDecl.uploadId, s, chunkOf(s));
  }
  assert.throws(() => store.finalize(badDecl.uploadId), DigestMismatchError);
  assert.equal(fs.readdirSync(path.join(dir, "final")).length, 0);
  store.close();
});

test("未登记上传的查询与操作报 NotFound", () => {
  const dir = tmpDir();
  const store = new TrainingMaterialStore(dir);
  assert.throws(() => store.getStatus("nope"), NotFoundError);
  assert.throws(() => store.receiveChunk("nope", 0, Buffer.alloc(CHUNK_SIZE)), NotFoundError);
  assert.throws(() => store.finalize("nope"), NotFoundError);
  store.close();
});

test("重开库后已确认分块保留", () => {
  const dir = tmpDir();
  let store = new TrainingMaterialStore(dir);
  store.registerUpload(DECL);
  store.receiveChunk(DECL.uploadId, 2, chunkOf(2));
  store.receiveChunk(DECL.uploadId, 0, chunkOf(0));
  store.close();

  store = new TrainingMaterialStore(dir);
  const st = store.getStatus(DECL.uploadId);
  assert.deepEqual(st.receivedChunks, [0, 2]);
  store.receiveChunk(DECL.uploadId, 1, chunkOf(1));
  store.receiveChunk(DECL.uploadId, 3, chunkOf(3));
  const r = store.finalize(DECL.uploadId);
  assert.ok(fs.readFileSync(r.filePath).equals(MATERIAL));
  store.close();
});
