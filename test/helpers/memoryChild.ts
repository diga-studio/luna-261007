/**
 * 100 MiB 入库内存测量子进程（需以 --expose-gc 运行）：
 *   node --expose-gc memoryChild.js <workDir>
 * 输出一行 JSON：{ usedDelta, peakDelta, productSha, expectedSha, productSize }
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as v8 from "node:v8";
import { createHash } from "node:crypto";
import {
  TrainingMaterialStore,
  CHUNK_SIZE,
  MAX_TOTAL_SIZE,
} from "../../src/index.js";

const dir = process.argv[2];
if (dir === undefined) {
  console.error("usage: memoryChild.js <workDir>");
  process.exit(2);
}

function gc(): void {
  (globalThis as { gc?: () => void }).gc?.();
}

function mem(): { used: number; peak: number } {
  const mu = process.memoryUsage();
  return {
    used: mu.heapUsed + mu.external,
    peak: v8.getHeapStatistics().peak_malloced_memory,
  };
}

// 流式生成 100 MiB 确定性素材
const materialPath = path.join(dir, "material.bin");
const matHash = createHash("sha256");
{
  const fd = fs.openSync(materialPath, "w");
  const buf = Buffer.allocUnsafe(CHUNK_SIZE);
  for (let off = 0; off < MAX_TOTAL_SIZE; off += buf.length) {
    for (let i = 0; i < buf.length; i++) {
      buf[i] = (off + i) % 256 ^ ((off / CHUNK_SIZE) & 0xff);
    }
    matHash.update(buf);
    fs.writeSync(fd, buf, 0, buf.length, off);
  }
  fs.closeSync(fd);
}
const expectedSha = matHash.digest("hex");

gc();
const before = mem();

const store = new TrainingMaterialStore(path.join(dir, "store"));
const uploadId = "big-100m";
store.registerUpload({ uploadId, totalSize: MAX_TOTAL_SIZE, sha256: expectedSha });

// 乱序提交：偶数块正序、奇数块倒序；每块读完即释放
const totalChunks = MAX_TOTAL_SIZE / CHUNK_SIZE;
const order: number[] = [];
for (let s = 0; s < totalChunks; s += 2) order.push(s);
for (let s = totalChunks - 1; s >= 1; s -= 2) order.push(s);
const mfd = fs.openSync(materialPath, "r");
for (const seq of order) {
  const chunk = Buffer.allocUnsafe(CHUNK_SIZE);
  let read = 0;
  while (read < CHUNK_SIZE) {
    read += fs.readSync(mfd, chunk, read, CHUNK_SIZE - read, seq * CHUNK_SIZE + read);
  }
  store.receiveChunk(uploadId, seq, chunk);
}
fs.closeSync(mfd);

const result = store.finalize(uploadId);
store.close();

gc();
const after = mem();

// 流式校验成品
const prodHash = createHash("sha256");
let productSize = 0;
{
  const fd = fs.openSync(result.filePath, "r");
  const buf = Buffer.allocUnsafe(CHUNK_SIZE);
  for (;;) {
    const n = fs.readSync(fd, buf, 0, buf.length, null);
    if (n === 0) break;
    prodHash.update(buf.subarray(0, n));
    productSize += n;
  }
  fs.closeSync(fd);
}

console.log(
  JSON.stringify({
    usedDelta: after.used - before.used,
    peakDelta: after.peak - before.peak,
    productSha: prodHash.digest("hex"),
    expectedSha,
    productSize,
  }),
);
