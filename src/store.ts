import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  ARTIFACTS_DIR_NAME,
  CHUNK_SIZE,
  CHUNKS_DIR_NAME,
  DB_FILE_NAME,
  MAX_TOTAL_SIZE,
  TMP_DIR_NAME,
} from './constants';
import { MetaDb, UploadRow } from './db';
import {
  ChunkConflictError,
  DeclarationMismatchError,
  DigestMismatchError,
  InvalidChunkError,
  StoreError,
  UploadIncompleteError,
  UploadNotFoundError,
  ValidationError,
} from './errors';
import { FinalizeResult, UploadDeclaration, UploadStatus } from './types';

const HEX_SHA256_RE = /^[0-9a-f]{64}$/;
const UPLOAD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function removeEntry(entryPath: string): void {
  fs.rmSync(entryPath, { recursive: true, force: true });
}

function sha256Hex(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export class TrainingMaterialStore {
  private readonly rootDir: string;
  private readonly chunksRoot: string;
  private readonly artifactsRoot: string;
  private readonly tmpRoot: string;
  private readonly db: MetaDb;

  private constructor(rootDir: string) {
    this.rootDir = rootDir;
    this.chunksRoot = path.join(rootDir, CHUNKS_DIR_NAME);
    this.artifactsRoot = path.join(rootDir, ARTIFACTS_DIR_NAME);
    this.tmpRoot = path.join(rootDir, TMP_DIR_NAME);
    ensureDir(this.chunksRoot);
    ensureDir(this.artifactsRoot);
    ensureDir(this.tmpRoot);
    this.db = new MetaDb(path.join(rootDir, DB_FILE_NAME));
    try {
      this.recover();
    } catch (err) {
      this.db.close();
      throw err;
    }
  }

  static open(rootDir: string): TrainingMaterialStore {
    return new TrainingMaterialStore(path.resolve(rootDir));
  }

  register(decl: UploadDeclaration): UploadStatus {
    const uploadId = validateUploadId(decl.uploadId);
    const totalSize = validateTotalSize(decl.totalSize);
    const sha256 = validateSha256(decl.sha256);
    const chunkCount = Math.ceil(totalSize / CHUNK_SIZE);

    const existing = this.db.getUpload(uploadId);
    if (existing) {
      if (existing.total_size !== totalSize || existing.sha256 !== sha256) {
        throw new DeclarationMismatchError(uploadId);
      }
      return this.toStatus(existing);
    }

    this.db.insertUpload({
      upload_id: uploadId,
      total_size: totalSize,
      sha256,
      chunk_count: chunkCount,
      state: 'uploading',
      artifact_path: null,
    });
    return this.toStatus(this.mustGetUpload(uploadId));
  }

  receiveChunk(uploadId: string, chunkIndex: number, data: Buffer): void {
    const upload = this.getUploadOrThrow(uploadId);
    if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= upload.chunk_count) {
      throw new InvalidChunkError(
        `chunk index ${chunkIndex} out of range [0, ${upload.chunk_count})`,
      );
    }
    if (!Buffer.isBuffer(data)) {
      throw new InvalidChunkError('chunk data must be a Buffer');
    }
    const expectedSize = this.expectedChunkSize(upload, chunkIndex);
    if (data.length !== expectedSize) {
      throw new InvalidChunkError(
        `chunk ${chunkIndex} must be ${expectedSize} bytes, got ${data.length}`,
      );
    }

    const digest = sha256Hex(data);
    const existing = this.db.getChunk(uploadId, chunkIndex);
    if (existing) {
      if (existing.sha256 === digest) {
        return;
      }
      throw new ChunkConflictError(uploadId, chunkIndex);
    }

    const uploadDir = path.join(this.chunksRoot, uploadId);
    ensureDir(uploadDir);
    const tmpPath = path.join(this.tmpRoot, `chunk-${crypto.randomUUID()}.part`);
    const fd = fs.openSync(tmpPath, 'w');
    try {
      fs.writeSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, path.join(uploadDir, String(chunkIndex)));
    this.db.insertChunk({
      upload_id: uploadId,
      chunk_index: chunkIndex,
      sha256: digest,
      size: data.length,
    });
  }

  finalize(uploadId: string): FinalizeResult {
    const upload = this.getUploadOrThrow(uploadId);
    const artifactPath = path.join(this.artifactsRoot, uploadId);

    if (upload.state === 'completed') {
      if (!fs.existsSync(artifactPath)) {
        throw new StoreError(`artifact missing for completed upload: ${uploadId}`);
      }
      return { uploadId, artifactPath };
    }

    const chunks = this.db.listChunks(uploadId);
    if (chunks.length !== upload.chunk_count) {
      throw new UploadIncompleteError(uploadId);
    }

    const tmpPath = path.join(this.tmpRoot, `final-${crypto.randomUUID()}.part`);
    const hash = crypto.createHash('sha256');
    let totalWritten = 0;
    const readBuffer = Buffer.allocUnsafe(CHUNK_SIZE);
    const fd = fs.openSync(tmpPath, 'w');
    try {
      for (let index = 0; index < upload.chunk_count; index += 1) {
        const chunkPath = path.join(this.chunksRoot, uploadId, String(index));
        const expected = this.expectedChunkSize(upload, index);
        let chunkFd: number;
        try {
          chunkFd = fs.openSync(chunkPath, 'r');
        } catch {
          throw new UploadIncompleteError(uploadId);
        }
        let bytesRead = 0;
        try {
          while (bytesRead < expected) {
            bytesRead += fs.readSync(
              chunkFd,
              readBuffer,
              bytesRead,
              expected - bytesRead,
              bytesRead,
            );
          }
        } finally {
          fs.closeSync(chunkFd);
        }
        if (bytesRead !== expected) {
          throw new StoreError(
            `chunk file size mismatch at ${chunkPath}: expected ${expected}, got ${bytesRead}`,
          );
        }
        const view = readBuffer.subarray(0, expected);
        hash.update(view);
        fs.writeSync(fd, view);
        totalWritten += expected;
      }
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    const digest = hash.digest('hex');
    if (totalWritten !== upload.total_size || digest !== upload.sha256) {
      removeEntry(tmpPath);
      throw new DigestMismatchError(uploadId);
    }

    fs.renameSync(tmpPath, artifactPath);
    this.db.markCompleted(uploadId, artifactPath);
    return { uploadId, artifactPath };
  }

  getStatus(uploadId: string): UploadStatus {
    return this.toStatus(this.getUploadOrThrow(uploadId));
  }

  close(): void {
    this.db.close();
  }

  private getUploadOrThrow(uploadId: string): UploadRow {
    const row = this.db.getUpload(uploadId);
    if (!row) {
      throw new UploadNotFoundError(uploadId);
    }
    return row;
  }

  private mustGetUpload(uploadId: string): UploadRow {
    const row = this.db.getUpload(uploadId);
    if (!row) {
      throw new StoreError(`internal: upload row missing after insert: ${uploadId}`);
    }
    return row;
  }

  private expectedChunkSize(upload: UploadRow, chunkIndex: number): number {
    if (chunkIndex < upload.chunk_count - 1) {
      return CHUNK_SIZE;
    }
    return upload.total_size - (upload.chunk_count - 1) * CHUNK_SIZE;
  }

  private toStatus(upload: UploadRow): UploadStatus {
    const receivedChunks = this.db
      .listChunks(upload.upload_id)
      .map((row) => row.chunk_index);
    return {
      uploadId: upload.upload_id,
      state: upload.state === 'completed' ? 'completed' : 'uploading',
      totalSize: upload.total_size,
      sha256: upload.sha256,
      chunkCount: upload.chunk_count,
      receivedChunks,
      artifactPath: upload.artifact_path,
    };
  }

  private recover(): void {
    for (const entry of fs.readdirSync(this.tmpRoot)) {
      removeEntry(path.join(this.tmpRoot, entry));
    }

    const knownIds = new Set(this.db.listUploads().map((row) => row.upload_id));

    for (const entry of fs.readdirSync(this.chunksRoot)) {
      const uploadDir = path.join(this.chunksRoot, entry);
      if (!knownIds.has(entry)) {
        removeEntry(uploadDir);
        continue;
      }
      if (!fs.statSync(uploadDir).isDirectory()) {
        removeEntry(uploadDir);
        continue;
      }
      const upload = this.db.getUpload(entry)!;
      for (const file of fs.readdirSync(uploadDir)) {
        const filePath = path.join(uploadDir, file);
        const index = /^[0-9]+$/.test(file) ? Number(file) : -1;
        if (index < 0 || index >= upload.chunk_count) {
          removeEntry(filePath);
          continue;
        }
        if (!this.db.getChunk(entry, index)) {
          const data = fs.readFileSync(filePath);
          if (data.length !== this.expectedChunkSize(upload, index)) {
            removeEntry(filePath);
            continue;
          }
          this.db.insertChunk({
            upload_id: entry,
            chunk_index: index,
            sha256: sha256Hex(data),
            size: data.length,
          });
        }
      }
    }

    for (const entry of fs.readdirSync(this.artifactsRoot)) {
      if (!knownIds.has(entry)) {
        removeEntry(path.join(this.artifactsRoot, entry));
      }
    }

    for (const row of this.db.listUploads()) {
      if (row.state !== 'completed') {
        const artifactPath = path.join(this.artifactsRoot, row.upload_id);
        if (fs.existsSync(artifactPath)) {
          this.db.markCompleted(row.upload_id, artifactPath);
        }
      }
    }
  }
}

function validateUploadId(uploadId: unknown): string {
  if (typeof uploadId !== 'string' || !UPLOAD_ID_RE.test(uploadId)) {
    throw new ValidationError(
      'uploadId must be 1-200 chars of [A-Za-z0-9._-] and start with alphanumeric',
    );
  }
  return uploadId;
}

function validateTotalSize(totalSize: unknown): number {
  if (
    typeof totalSize !== 'number' ||
    !Number.isInteger(totalSize) ||
    totalSize <= 0 ||
    totalSize > MAX_TOTAL_SIZE
  ) {
    throw new ValidationError(
      `totalSize must be an integer in [1, ${MAX_TOTAL_SIZE}]`,
    );
  }
  return totalSize;
}

function validateSha256(sha256: unknown): string {
  if (typeof sha256 !== 'string') {
    throw new ValidationError('sha256 must be a hex string');
  }
  const normalized = sha256.toLowerCase();
  if (!HEX_SHA256_RE.test(normalized)) {
    throw new ValidationError('sha256 must be 64 hex characters');
  }
  return normalized;
}
