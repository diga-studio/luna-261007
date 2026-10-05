import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { TrainingMaterialStore, CHUNK_SIZE } from "../src/index.js";
import {
  CYCLE_TOTAL_CHUNKS,
  CYCLE_UPLOAD_ID,
  makeCycleMaterial,
} from "./helpers/material.js";

const CHILD = path.resolve("build/test/helpers/crashChild.js");
const MATERIAL = makeCycleMaterial();
const MATERIAL_SHA = createHash("sha256").update(MATERIAL).digest("hex");

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ingest-crash-"));
}

function runChild(dir: string, crashAt: string, seed = 0): void {
  const r = spawnSync(
    process.execPath,
    [CHILD, dir, crashAt, String(seed)],
    { stdio: "pipe", timeout: 60_000 },
  );
  if (r.error) throw r.error;
  // 崩溃点被 SIGKILL 终止属预期；其它非零退出要暴露
  if (r.signal === null && r.status !== 0) {
    throw new Error(
      `child failed: status=${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`,
    );
  }
}

/** 递归收集目录下所有文件名，断言没有临时文件。 */
function assertNoTmpFiles(dir: string): void {
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      assert.ok(
        !e.name.includes(".tmp-"),
        `orphan temp file left: ${path.join(d, e.name)}`,
      );
      if (e.isDirectory()) walk(path.join(d, e.name));
    }
  };
  walk(dir);
}

function finalFiles(dir: string): string[] {
  const finalDir = path.join(dir, "final");
  return fs.existsSync(finalDir) ? fs.readdirSync(finalDir) : [];
}

test("接收分块在 tmpWritten 点中断：半块不可见，重开后可继续", () => {
  const dir = tmpDir();
  runChild(dir, "chunk.tmpWritten");

  const store = new TrainingMaterialStore(dir); // 重开触发恢复清理
  assertNoTmpFiles(dir);
  const st = store.getStatus(CYCLE_UPLOAD_ID);
  assert.deepEqual(st.receivedChunks, [], "tmp 未提交，分块不得可见");
  // 重试同一分块成功，最终成品一致
  for (let s = 0; s < CYCLE_TOTAL_CHUNKS; s++) {
    store.receiveChunk(
      CYCLE_UPLOAD_ID,
      s,
      MATERIAL.subarray(s * CHUNK_SIZE, (s + 1) * CHUNK_SIZE),
    );
  }
  const r = store.finalize(CYCLE_UPLOAD_ID);
  assert.ok(fs.readFileSync(r.filePath).equals(MATERIAL));
  store.close();
  assertNoTmpFiles(dir);
});

test("接收分块在 renamed 点中断：恢复后分块保留且内容正确", () => {
  const dir = tmpDir();
  runChild(dir, "chunk.renamed");

  const store = new TrainingMaterialStore(dir);
  const st = store.getStatus(CYCLE_UPLOAD_ID);
  assert.deepEqual(st.receivedChunks, [0], "rename 已完成的分块恢复后必须保留");
  // 重复提交相同内容幂等；冲突内容被拒绝
  store.receiveChunk(CYCLE_UPLOAD_ID, 0, MATERIAL.subarray(0, CHUNK_SIZE));
  const evil = Buffer.from(MATERIAL.subarray(0, CHUNK_SIZE));
  evil[0] = (evil[0] ?? 0) ^ 0xff;
  assert.throws(() => store.receiveChunk(CYCLE_UPLOAD_ID, 0, evil));
  for (let s = 1; s < CYCLE_TOTAL_CHUNKS; s++) {
    store.receiveChunk(
      CYCLE_UPLOAD_ID,
      s,
      MATERIAL.subarray(s * CHUNK_SIZE, (s + 1) * CHUNK_SIZE),
    );
  }
  const r = store.finalize(CYCLE_UPLOAD_ID);
  assert.ok(fs.readFileSync(r.filePath).equals(MATERIAL));
  store.close();
  assertNoTmpFiles(dir);
});

test("接收分块在 committed 点中断：已确认分块重开后保留", () => {
  const dir = tmpDir();
  runChild(dir, "chunk.committed");

  const store = new TrainingMaterialStore(dir);
  assert.deepEqual(store.getStatus(CYCLE_UPLOAD_ID).receivedChunks, [0]);
  store.close();
});

test("完成入库在 tmpWritten 点中断：不产生半成品，可继续完成", () => {
  const dir = tmpDir();
  runChild(dir, "finalize.tmpWritten");

  const store = new TrainingMaterialStore(dir); // 重开触发恢复清理
  assertNoTmpFiles(dir);
  assert.equal(finalFiles(dir).length, 0, "不得有半成品成品文件");
  const st = store.getStatus(CYCLE_UPLOAD_ID);
  assert.equal(st.complete, false);
  assert.deepEqual(st.receivedChunks, [0, 1, 2], "已确认分块不丢失");
  const r = store.finalize(CYCLE_UPLOAD_ID);
  assert.ok(fs.readFileSync(r.filePath).equals(MATERIAL));
  store.close();
  assertNoTmpFiles(dir);
});

test("完成入库在 renamed 点中断：恢复后即为可完整读取的成品", () => {
  const dir = tmpDir();
  runChild(dir, "finalize.renamed");

  const store = new TrainingMaterialStore(dir);
  const st = store.getStatus(CYCLE_UPLOAD_ID);
  assert.equal(st.complete, true, "成品已落盘且校验通过，恢复后必须完成");
  assert.ok(fs.readFileSync(st.filePath as string).equals(MATERIAL));
  // 重复完成收敛到同一位置
  const r = store.finalize(CYCLE_UPLOAD_ID);
  assert.equal(r.filePath, st.filePath);
  store.close();
  assertNoTmpFiles(dir);
});

test("完成入库在 committed 点中断：重开后状态为完成", () => {
  const dir = tmpDir();
  runChild(dir, "finalize.committed");

  const store = new TrainingMaterialStore(dir);
  const st = store.getStatus(CYCLE_UPLOAD_ID);
  assert.equal(st.complete, true);
  assert.ok(fs.readFileSync(st.filePath as string).equals(MATERIAL));
  store.close();
});

test("累计 100 次中断/恢复/重试：唯一成品且无临时文件累积", { timeout: 300_000 }, () => {
  const dir = tmpDir();
  const crashPoints = [
    "chunk.tmpWritten",
    "chunk.renamed",
    "chunk.committed",
    "finalize.tmpWritten",
    "finalize.renamed",
    "finalize.committed",
    "afterWork",
  ];

  for (let i = 0; i < 100; i++) {
    runChild(dir, crashPoints[i % crashPoints.length] as string, i);
    // 每次中断后在父进程重开库（触发恢复），检查不变量
    const store = new TrainingMaterialStore(dir);
    const st = store.getStatus(CYCLE_UPLOAD_ID);
    if (st.complete) {
      assert.equal(finalFiles(dir).length, 1, "只能有一个成品");
      const hash = createHash("sha256")
        .update(fs.readFileSync(st.filePath as string))
        .digest("hex");
      assert.equal(hash, MATERIAL_SHA);
    }
    store.close();
    assertNoTmpFiles(dir);
  }

  // 最后一次干净运行，保证收敛
  runChild(dir, "none", 1000);
  const store = new TrainingMaterialStore(dir);
  const st = store.getStatus(CYCLE_UPLOAD_ID);
  assert.equal(st.complete, true);
  assert.ok(fs.readFileSync(st.filePath as string).equals(MATERIAL));
  assert.deepEqual(finalFiles(dir), [CYCLE_UPLOAD_ID]);
  store.close();
  assertNoTmpFiles(dir);
});
