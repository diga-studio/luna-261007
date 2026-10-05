import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

const TMP_SUFFIX = ".tmp-";
let tmpCounter = 0;

function fsyncDir(dir: string): void {
  const fd = fs.openSync(dir, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function isTmpName(name: string): boolean {
  return name.includes(TMP_SUFFIX);
}

/** 本地文件层：分块文件、成品文件、临时文件与崩溃恢复清理。 */
export class FileStore {
  private readonly rootDir: string;
  private readonly chunksDir: string;
  private readonly finalDir: string;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
    this.chunksDir = path.join(rootDir, "chunks");
    this.finalDir = path.join(rootDir, "final");
    fs.mkdirSync(this.chunksDir, { recursive: true });
    fs.mkdirSync(this.finalDir, { recursive: true });
  }

  private chunkDir(uploadId: string): string {
    return path.join(this.chunksDir, uploadId);
  }

  private chunkPath(uploadId: string, seq: number): string {
    return path.join(this.chunkDir(uploadId), String(seq));
  }

  private newTmpPath(targetPath: string): string {
    tmpCounter += 1;
    return `${targetPath}${TMP_SUFFIX}${process.pid}-${tmpCounter}`;
  }

  /** 分块文件是否已存在（已提交）。 */
  hasChunk(uploadId: string, seq: number): boolean {
    return fs.existsSync(this.chunkPath(uploadId, seq));
  }

  /** 读取已提交分块内容（用于冲突比对）。 */
  readChunk(uploadId: string, seq: number): Buffer {
    return fs.readFileSync(this.chunkPath(uploadId, seq));
  }

  /** 原子写入分块：临时文件 + fsync + rename + 目录 fsync。 */
  writeChunkAtomic(
    uploadId: string,
    seq: number,
    data: Uint8Array,
    onCrashPoint?: (point: "chunk.tmpWritten" | "chunk.renamed") => void,
  ): void {
    const dir = this.chunkDir(uploadId);
    fs.mkdirSync(dir, { recursive: true });
    const target = this.chunkPath(uploadId, seq);
    const tmp = this.newTmpPath(target);
    const fd = fs.openSync(tmp, "w");
    try {
      fs.writeSync(fd, data, 0, data.length, 0);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    onCrashPoint?.("chunk.tmpWritten");
    fs.renameSync(tmp, target);
    fsyncDir(dir);
    onCrashPoint?.("chunk.renamed");
  }

  /**
   * 拼接全部分块到成品临时文件并计算 SHA-256（不 rename）。
   * 每次只读一个分块，内存占用有界。
   */
  assembleFinalTmp(
    uploadId: string,
    chunkSeqs: number[],
  ): { tmpPath: string; sha256: string; totalSize: number } {
    const finalTarget = path.join(this.finalDir, uploadId);
    const tmp = this.newTmpPath(finalTarget);
    const hash = createHash("sha256");
    let totalSize = 0;
    const fd = fs.openSync(tmp, "w");
    try {
      for (const seq of chunkSeqs) {
        const buf = fs.readFileSync(this.chunkPath(uploadId, seq));
        hash.update(buf);
        fs.writeSync(fd, buf, 0, buf.length, totalSize);
        totalSize += buf.length;
      }
      fs.fsyncSync(fd);
    } catch (err) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
      fs.rmSync(tmp, { force: true });
      throw err;
    }
    fs.closeSync(fd);
    return { tmpPath: tmp, sha256: hash.digest("hex"), totalSize };
  }

  /** 校验通过后，把成品临时文件原子改名为成品。 */
  commitFinalTmp(tmpPath: string, uploadId: string): string {
    const finalRelPath = path.join("final", uploadId);
    fs.renameSync(tmpPath, path.join(this.rootDir, finalRelPath));
    fsyncDir(this.finalDir);
    return finalRelPath;
  }

  discardTmp(tmpPath: string): void {
    fs.rmSync(tmpPath, { force: true });
  }

  finalExists(finalRelPath: string): boolean {
    return fs.existsSync(path.join(this.rootDir, finalRelPath));
  }

  /** 计算任意文件 SHA-256 与长度（流式，恢复校验用）。 */
  hashFile(absPath: string): { sha256: string; size: number } {
    const hash = createHash("sha256");
    const fd = fs.openSync(absPath, "r");
    const buf = Buffer.allocUnsafe(1024 * 1024);
    let size = 0;
    try {
      for (;;) {
        const n = fs.readSync(fd, buf, 0, buf.length, null);
        if (n === 0) break;
        hash.update(buf.subarray(0, n));
        size += n;
      }
    } finally {
      fs.closeSync(fd);
    }
    return { sha256: hash.digest("hex"), size };
  }

  /** 读取成品文件的一段（完成后冲突比对用）。 */
  readFinalSlice(finalRelPath: string, offset: number, length: number): Buffer {
    const fd = fs.openSync(path.join(this.rootDir, finalRelPath), "r");
    try {
      const buf = Buffer.alloc(length);
      let read = 0;
      while (read < length) {
        const n = fs.readSync(fd, buf, read, length - read, offset + read);
        if (n === 0) break;
        read += n;
      }
      return buf.subarray(0, read);
    } finally {
      fs.closeSync(fd);
    }
  }

  absPath(relPath: string): string {
    return path.join(this.rootDir, relPath);
  }

  /**
   * 打开时的恢复清理：
   * - 删除所有分块/成品临时文件；
   * - 返回磁盘上已提交的分块（uploadId -> seq 列表）与已存在的成品 uploadId，
   *   交由上层与元数据对账。
   */
  recover(): { chunksOnDisk: Map<string, number[]>; finalsOnDisk: string[] } {
    const chunksOnDisk = new Map<string, number[]>();
    for (const entry of fs.readdirSync(this.chunksDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(this.chunksDir, entry.name);
      const seqs: number[] = [];
      for (const f of fs.readdirSync(dir)) {
        if (isTmpName(f)) {
          fs.rmSync(path.join(dir, f), { force: true });
          continue;
        }
        const seq = Number(f);
        if (Number.isInteger(seq) && seq >= 0 && String(seq) === f) {
          seqs.push(seq);
        }
      }
      seqs.sort((a, b) => a - b);
      if (seqs.length > 0) chunksOnDisk.set(entry.name, seqs);
      if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
    }
    const finalsOnDisk: string[] = [];
    for (const f of fs.readdirSync(this.finalDir)) {
      if (isTmpName(f)) {
        fs.rmSync(path.join(this.finalDir, f), { force: true });
        continue;
      }
      finalsOnDisk.push(f);
    }
    return { chunksOnDisk, finalsOnDisk };
  }

  /** 已提交分块文件的字节数（恢复对账用）。 */
  chunkFileSize(uploadId: string, seq: number): number {
    return fs.statSync(this.chunkPath(uploadId, seq)).size;
  }

  /** 删除成品文件（恢复时发现成品与声明不符）。 */
  removeFinalFile(uploadId: string): void {
    fs.rmSync(path.join(this.finalDir, uploadId), { force: true });
    fsyncDir(this.finalDir);
  }

  /** 删除某上传的全部分块文件（成品已生成后清理用）。 */
  removeChunks(uploadId: string): void {
    fs.rmSync(this.chunkDir(uploadId), { recursive: true, force: true });
    fsyncDir(this.chunksDir);
  }
}
