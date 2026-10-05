/**
 * 崩溃注入子进程：
 *   node crashChild.js <dir> <crashAt|none|afterWork> [seed]
 * 在指定崩溃点用 SIGKILL 自杀，模拟进程在调用尚未返回时被终止。
 */
import { createHash } from "node:crypto";
import { TrainingMaterialStore, CHUNK_SIZE } from "../../src/index.js";
import {
  CYCLE_TOTAL_CHUNKS,
  CYCLE_UPLOAD_ID,
  makeCycleMaterial,
} from "./material.js";

const [dir, crashAt, seedStr] = process.argv.slice(2);
if (dir === undefined || crashAt === undefined) {
  console.error("usage: crashChild.js <dir> <crashAt> [seed]");
  process.exit(2);
}
const seed = Number(seedStr ?? "0");

const material = makeCycleMaterial();
const decl = {
  uploadId: CYCLE_UPLOAD_ID,
  totalSize: material.length,
  sha256: createHash("sha256").update(material).digest("hex"),
};

const store = new TrainingMaterialStore(dir, {
  hooks: {
    onCrashPoint: (point) => {
      if (point === crashAt) process.kill(process.pid, "SIGKILL");
    },
  },
});

store.registerUpload(decl);

// 确定性乱序：按 seed 旋转，奇数 seed 再反转
const order = Array.from({ length: CYCLE_TOTAL_CHUNKS }, (_, i) => i);
const rotated = order.map((_, i) => order[(i + seed) % order.length] as number);
if (seed % 2 === 1) rotated.reverse();

for (const seq of rotated) {
  const chunk = material.subarray(seq * CHUNK_SIZE, (seq + 1) * CHUNK_SIZE);
  store.receiveChunk(decl.uploadId, seq, chunk);
  // 夹入内容冲突的重试（应被拒绝且不破坏进度）
  const evil = Buffer.from(chunk);
  evil[0] = (evil[0] ?? 0) ^ 0xff;
  try {
    store.receiveChunk(decl.uploadId, seq, evil);
  } catch {
    // 预期：ChunkConflictError
  }
  // 重复提交相同内容（幂等）
  store.receiveChunk(decl.uploadId, seq, chunk);
}

store.finalize(decl.uploadId);

if (crashAt === "afterWork") process.kill(process.pid, "SIGKILL");
console.log("CHILD_DONE");
