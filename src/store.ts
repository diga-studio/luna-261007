import * as fs from "node:fs";
import * as path from "node:path";
import { MetadataDb } from "./database.js";
import { FileStore } from "./fileStore.js";
import {
  ChunkConflictError,
  DigestMismatchError,
  IncompleteUploadError,
  InvalidChunkError,
  InvalidDeclarationError,
  NotFoundError,
} from "./errors.js";
import type {
  CrashPoint,
  FinalizeResult,
  StoreOptions,
  UploadDeclaration,
  UploadStatus,
} from "./types.js";
import type { UploadRow } from "./database.js";

export const CHUNK_SIZE = 1024 * 1024; // 1 MiB
export const MAX_TOTAL_SIZE = 100 * 1024 * 1024; // 100 MiB

const UPLOAD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

function validateDeclaration(decl: UploadDeclaration): void {
  if (
    typeof decl.uploadId !== "string" ||
    !UPLOAD_ID_RE.test(decl.uploadId) ||
    decl.uploadId.includes("..")
  ) {
    throw new InvalidDeclarationError(`invalid uploadId: ${String(decl.uploadId)}`);
  }
  if (
    !Number.isInteger(decl.totalSize) ||
    decl.totalSize < 1 ||
    decl.totalSize > MAX_TOTAL_SIZE
  ) {
    throw new InvalidDeclarationError(
      `totalSize must be an integer in 1..${MAX_TOTAL_SIZE}, got ${String(decl.totalSize)}`,
    );
  }
  if (typeof decl.sha256 !== "string" || !SHA256_RE.test(decl.sha256)) {
    throw new InvalidDeclarationError("sha256 must be 64 lowercase hex chars");
  }
}

function totalChunksOf(totalSize: number): number {
  return Math.ceil(totalSize / CHUNK_SIZE);
}

/**
 * 培训素材可恢复分块入库库。
 * 上层串行调用；同一目录只由一个实例使用。
 */
export class TrainingMaterialStore {
  private readonly db: MetadataDb;
  private readonly files: FileStore;
  private readonly onCrashPoint: (point: CrashPoint) => void;

  constructor(dir: string, options?: StoreOptions) {
    fs.mkdirSync(dir, { recursive: true });
    this.files = new FileStore(dir);
    this.db = new MetadataDb(path.join(dir, "meta.sqlite3"));
    this.onCrashPoint = options?.hooks?.onCrashPoint ?? (() => {});
    this.recover();
  }

  /**
   * 打开时的恢复：
   * - 清理所有临时文件（FileStore.recover）；
   * - 磁盘已提交但元数据缺失的分块补登记；
   * - 成品已生成但元数据未标记完成的，校验摘要后补标记，不符则删除；
   * - 删除无主分块目录与无主成品文件。
   */
  private recover(): void {
    const { chunksOnDisk, finalsOnDisk } = this.files.recover();
    const finalSet = new Set(finalsOnDisk);

    for (const up of this.db.listUploads()) {
      if (up.status === "complete") {
        finalSet.delete(up.uploadId);
        if (chunksOnDisk.delete(up.uploadId)) {
          this.files.removeChunks(up.uploadId);
        }
        continue;
      }
      if (finalSet.delete(up.uploadId)) {
        // 成品文件已落盘但元数据未提交：校验后补登记或删除。
        const rel = path.join("final", up.uploadId);
        const { sha256, size } = this.files.hashFile(this.files.absPath(rel));
        if (sha256 === up.sha256 && size === up.totalSize) {
          this.db.markComplete(up.uploadId, rel);
          if (chunksOnDisk.delete(up.uploadId)) {
            this.files.removeChunks(up.uploadId);
          }
        } else {
          this.files.removeFinalFile(up.uploadId);
        }
        continue;
      }
      const seqs = chunksOnDisk.get(up.uploadId);
      if (seqs !== undefined) {
        const totalChunks = totalChunksOf(up.totalSize);
        for (const seq of seqs) {
          if (seq < totalChunks && !this.db.hasChunk(up.uploadId, seq)) {
            this.db.addChunk(
              up.uploadId,
              seq,
              this.files.chunkFileSize(up.uploadId, seq),
            );
          }
        }
        chunksOnDisk.delete(up.uploadId);
      }
    }

    // 无主分块目录与无主成品文件：删除，避免累积。
    for (const uploadId of chunksOnDisk.keys()) {
      this.files.removeChunks(uploadId);
    }
    for (const uploadId of finalSet) {
      this.files.removeFinalFile(uploadId);
    }
  }

  private mustGet(uploadId: string): UploadRow {
    const row = this.db.getUpload(uploadId);
    if (row === null) throw new NotFoundError(uploadId);
    return row;
  }

  /** 登记上传。重复登记同声明幂等；不同声明抛 DeclarationConflictError。 */
  registerUpload(decl: UploadDeclaration): void {
    validateDeclaration(decl);
    this.db.registerUpload(decl);
  }

  /**
   * 接收一个分块。同序号同内容幂等成功；同序号不同内容抛 ChunkConflictError。
   * 返回成功后，重开库必须保留该分块。
   */
  receiveChunk(uploadId: string, seq: number, data: Uint8Array): void {
    const up = this.mustGet(uploadId);
    const totalChunks = totalChunksOf(up.totalSize);
    if (!Number.isInteger(seq) || seq < 0 || seq >= totalChunks) {
      throw new InvalidChunkError(
        `chunk seq out of range: ${String(seq)} (totalChunks=${totalChunks})`,
      );
    }
    const expectedSize =
      seq === totalChunks - 1 ? up.totalSize - seq * CHUNK_SIZE : CHUNK_SIZE;
    if (data.length !== expectedSize) {
      throw new InvalidChunkError(
        `chunk ${seq} size must be ${expectedSize}, got ${data.length}`,
      );
    }

    if (up.status === "complete") {
      // 已完成：与成品对应区间比对，相同视为幂等成功，不同拒绝且不改写。
      const slice = this.files.readFinalSlice(
        up.finalPath as string,
        seq * CHUNK_SIZE,
        expectedSize,
      );
      if (Buffer.from(data).equals(slice)) return;
      throw new ChunkConflictError(uploadId, seq);
    }

    if (this.db.hasChunk(uploadId, seq)) {
      const existing = this.files.readChunk(uploadId, seq);
      if (existing.equals(data)) return;
      throw new ChunkConflictError(uploadId, seq);
    }
    if (this.files.hasChunk(uploadId, seq)) {
      // 磁盘有但元数据缺失（上次写入后未提交）：相同则补登记，不同则覆盖。
      const existing = this.files.readChunk(uploadId, seq);
      if (existing.equals(data)) {
        this.db.addChunk(uploadId, seq, data.length);
        return;
      }
    }

    this.files.writeChunkAtomic(uploadId, seq, data, (point) =>
      this.onCrashPoint(point),
    );
    this.db.addChunk(uploadId, seq, data.length);
    this.onCrashPoint("chunk.committed");
  }

  /**
   * 完成入库。仅当分块齐全且拼接长度、摘要符合声明时成功。
   * 重复调用返回同一成品位置。
   */
  finalize(uploadId: string): FinalizeResult {
    const up = this.mustGet(uploadId);
    if (up.status === "complete") {
      return {
        uploadId,
        filePath: this.files.absPath(up.finalPath as string),
      };
    }

    const chunks = this.db.listChunks(uploadId);
    const totalChunks = totalChunksOf(up.totalSize);
    const contiguous =
      chunks.length === totalChunks &&
      chunks.every((c, i) => c.seq === i);
    if (!contiguous) throw new IncompleteUploadError(uploadId);

    const assembled = this.files.assembleFinalTmp(
      uploadId,
      chunks.map((c) => c.seq),
    );
    this.onCrashPoint("finalize.tmpWritten");

    if (assembled.sha256 !== up.sha256 || assembled.totalSize !== up.totalSize) {
      this.files.discardTmp(assembled.tmpPath);
      throw new DigestMismatchError(uploadId);
    }

    const finalRelPath = this.files.commitFinalTmp(assembled.tmpPath, uploadId);
    this.onCrashPoint("finalize.renamed");
    this.db.markComplete(uploadId, finalRelPath);
    this.onCrashPoint("finalize.committed");
    this.files.removeChunks(uploadId);

    return { uploadId, filePath: this.files.absPath(finalRelPath) };
  }

  /** 查询状态；只反映已完整接收并确认的分块。 */
  getStatus(uploadId: string): UploadStatus {
    const up = this.mustGet(uploadId);
    const chunks = this.db.listChunks(uploadId);
    const receivedBytes = chunks.reduce((sum, c) => sum + c.size, 0);
    const status: UploadStatus = {
      uploadId: up.uploadId,
      totalSize: up.totalSize,
      sha256: up.sha256,
      receivedChunks: chunks.map((c) => c.seq),
      receivedBytes,
      totalChunks: totalChunksOf(up.totalSize),
      complete: up.status === "complete",
    };
    if (up.status === "complete") {
      status.filePath = this.files.absPath(up.finalPath as string);
    }
    return status;
  }

  close(): void {
    this.db.close();
  }
}
