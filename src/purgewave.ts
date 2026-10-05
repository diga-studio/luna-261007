import { existsSync, mkdirSync, statSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { JobDatabase, type FileRow, type JobRow } from "./db.js";
import { RetentionStore } from "./storage.js";
import type { FileStatus, JobFileResult, JobView, OperationReport } from "./types.js";

export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_PATHS_PER_JOB = 5000;

export type PurgeWaveErrorCode =
  | "UNKNOWN_JOB"
  | "INVALID_PATHS"
  | "TOO_MANY_PATHS"
  | "PATH_IN_STORAGE"
  | "EXPIRED"
  | "NOT_EXPIRED";

export class PurgeWaveError extends Error {
  code: PurgeWaveErrorCode;
  constructor(code: PurgeWaveErrorCode, message: string) {
    super(message);
    this.name = "PurgeWaveError";
    this.code = code;
  }
}

export interface PurgeWaveOptions {
  dir: string;
  now?: () => number;
  crashHook?: (point: string) => void;
}

export class PurgeWave {
  private db: JobDatabase;
  private store: RetentionStore;
  private nowFn: () => number;
  private crashHook: (point: string) => void;
  private storageRoot: string;

  constructor(options: PurgeWaveOptions) {
    this.storageRoot = resolve(options.dir);
    mkdirSync(this.storageRoot, { recursive: true });
    this.nowFn = options.now ?? (() => Date.now());
    this.crashHook = options.crashHook ?? (() => {});
    this.db = new JobDatabase(join(this.storageRoot, "purgewave.db"));
    this.store = new RetentionStore(join(this.storageRoot, "retained"));
    this.recover();
  }

  close(): void {
    this.db.close();
  }

  private recover(): void {
    for (const op of this.db.listJobsWithIncompleteOps()) {
      const job = this.db.getJob(op.jobId);
      if (!job) continue;
      if (op.kind === "clean") this.runClean(job);
      else if (op.kind === "undo") this.runUndo(job);
      else this.runReclaim(job, op.startedAt);
      this.db.completeOp(op.jobId, op.kind);
    }
    const known = new Set(this.db.listStoredNames());
    for (const orphan of this.store.listOrphans(known)) {
      this.store.remove(orphan);
    }
  }

  clean(jobId: string, paths: string[]): OperationReport {
    if (!Array.isArray(paths) || paths.length === 0) {
      throw new PurgeWaveError("INVALID_PATHS", "paths must be a non-empty array");
    }
    const distinct = [...new Set(paths.map((p) => resolve(p)))];
    if (distinct.length > MAX_PATHS_PER_JOB) {
      throw new PurgeWaveError("TOO_MANY_PATHS", "a job accepts at most 5000 distinct paths");
    }
    const receivedAt = this.nowFn();
    const existedBefore = this.db.getJob(jobId) !== null;
    const job = this.db.createJobIfAbsent(jobId, receivedAt, receivedAt + RETENTION_MS);
    if (!existedBefore) {
      for (const p of distinct) {
        this.assertCleanable(p);
      }
      this.db.addFilesIfAbsent(jobId, distinct);
    }
    const op = this.db.beginOp(jobId, "clean", job.receivedAt);
    if (!op.done) {
      this.runClean(job);
      this.db.completeOp(jobId, "clean");
    }
    this.crashHook("clean:before-return");
    return this.report(jobId);
  }

  undo(jobId: string): OperationReport {
    const job = this.requireJob(jobId);
    let op = this.db.getOp(jobId, "undo");
    if (op && op.done) {
      const hasConflict = this.db
        .listFiles(jobId)
        .some((file) => file.status === "conflict");
      if (!hasConflict) {
        this.crashHook("undo:before-return");
        return this.report(jobId);
      }
      const now = this.nowFn();
      if (now >= job.expiresAt) {
        throw new PurgeWaveError("EXPIRED", "retention period has ended; undo is no longer allowed");
      }
      this.db.restartOp(jobId, "undo", now);
      op = this.db.getOp(jobId, "undo")!;
    }
    if (!op) {
      const now = this.nowFn();
      if (now >= job.expiresAt) {
        throw new PurgeWaveError("EXPIRED", "retention period has ended; undo is no longer allowed");
      }
      this.db.beginOp(jobId, "undo", now);
      op = this.db.getOp(jobId, "undo")!;
    }
    if (!op.done) {
      this.runUndo(job);
      this.db.completeOp(jobId, "undo");
    }
    this.crashHook("undo:before-return");
    return this.report(jobId);
  }

  reclaim(jobId: string): OperationReport {
    const job = this.requireJob(jobId);
    const existing = this.db.getOp(jobId, "reclaim");
    if (!existing) {
      const now = this.nowFn();
      if (now < job.expiresAt) {
        throw new PurgeWaveError("NOT_EXPIRED", "retention period has not ended yet");
      }
      this.db.beginOp(jobId, "reclaim", now);
    }
    const op = this.db.getOp(jobId, "reclaim")!;
    if (!op.done) {
      this.runReclaim(job, op.startedAt);
      this.db.completeOp(jobId, "reclaim");
    }
    this.crashHook("reclaim:before-return");
    return this.report(jobId);
  }

  getJob(jobId: string): JobView {
    const job = this.requireJob(jobId);
    return {
      jobId: job.jobId,
      receivedAt: job.receivedAt,
      expiresAt: job.expiresAt,
      files: this.publicFiles(jobId),
    };
  }

  private requireJob(jobId: string): JobRow {
    const job = this.db.getJob(jobId);
    if (!job) {
      throw new PurgeWaveError("UNKNOWN_JOB", `unknown job id: ${jobId}`);
    }
    return job;
  }

  private assertCleanable(path: string): void {
    if (!isAbsolute(path)) {
      throw new PurgeWaveError("INVALID_PATHS", `path must be absolute: ${path}`);
    }
    if (path === this.storageRoot || path.startsWith(this.storageRoot + sep)) {
      throw new PurgeWaveError("PATH_IN_STORAGE", `path is inside the module storage dir: ${path}`);
    }
    let stat;
    try {
      stat = statSync(path);
    } catch {
      throw new PurgeWaveError("INVALID_PATHS", `path does not exist: ${path}`);
    }
    if (!stat.isFile()) {
      throw new PurgeWaveError("INVALID_PATHS", `path is not a regular file: ${path}`);
    }
  }

  private runClean(job: JobRow): void {
    for (const file of this.db.listFiles(job.jobId)) {
      if (file.status === "pending") {
        const storedName = this.store.newStoredName();
        this.db.setFileStatus(job.jobId, file.path, "claimed", storedName);
        this.crashHook("clean:claimed");
        this.store.moveIn(file.path, storedName);
        this.crashHook("clean:moved");
        this.db.setFileStatus(job.jobId, file.path, "cleaned");
        this.crashHook("clean:recorded");
      } else if (file.status === "claimed" && file.storedName) {
        if (this.store.has(file.storedName)) {
          this.db.setFileStatus(job.jobId, file.path, "cleaned");
        } else if (existsSync(file.path)) {
          this.store.moveIn(file.path, file.storedName);
          this.db.setFileStatus(job.jobId, file.path, "cleaned");
        } else {
          this.db.setFileStatus(job.jobId, file.path, "cleaned", null);
        }
      }
    }
  }

  private runUndo(job: JobRow): void {
    for (const file of this.db.listFiles(job.jobId)) {
      if (file.status === "restoring" && file.storedName) {
        this.finishRestore(job, file);
      } else if (file.status === "cleaned" || file.status === "conflict") {
        if (!file.storedName) continue;
        if (existsSync(file.path)) {
          this.db.setFileStatus(job.jobId, file.path, "conflict");
          this.crashHook("undo:conflict");
          continue;
        }
        this.db.setFileStatus(job.jobId, file.path, "restoring");
        this.crashHook("undo:restoring");
        this.store.moveOut(file.storedName, file.path);
        this.crashHook("undo:moved");
        this.db.setFileStatus(job.jobId, file.path, "restored", null);
        this.crashHook("undo:recorded");
      }
    }
  }

  private finishRestore(job: JobRow, file: FileRow): void {
    const storedName = file.storedName!;
    const storedExists = this.store.has(storedName);
    const originalExists = existsSync(file.path);
    if (originalExists && !storedExists) {
      this.db.setFileStatus(job.jobId, file.path, "restored", null);
    } else if (storedExists && !originalExists) {
      this.store.moveOut(storedName, file.path);
      this.db.setFileStatus(job.jobId, file.path, "restored", null);
    } else if (storedExists && originalExists) {
      this.db.setFileStatus(job.jobId, file.path, "conflict");
    } else {
      this.db.setFileStatus(job.jobId, file.path, "restored", null);
    }
  }

  private runReclaim(job: JobRow, startedAt: number): void {
    if (startedAt < job.expiresAt) return;
    for (const file of this.db.listFiles(job.jobId)) {
      if (file.status === "purging" && file.storedName) {
        this.store.remove(file.storedName);
        this.db.setFileStatus(job.jobId, file.path, "purged", null);
      } else if (
        (file.status === "cleaned" || file.status === "conflict") &&
        file.storedName
      ) {
        this.db.setFileStatus(job.jobId, file.path, "purging");
        this.crashHook("reclaim:purging");
        this.store.remove(file.storedName);
        this.crashHook("reclaim:removed");
        this.db.setFileStatus(job.jobId, file.path, "purged", null);
        this.crashHook("reclaim:recorded");
      }
    }
  }

  private publicFiles(jobId: string): JobFileResult[] {
    return this.db.listFiles(jobId).map((file) => ({
      path: file.path,
      status: this.publicStatus(file),
    }));
  }

  private publicStatus(file: FileRow): FileStatus {
    switch (file.status) {
      case "pending":
      case "claimed":
        return "pending";
      case "cleaned":
      case "restoring":
      case "purging":
        return "cleaned";
      case "restored":
        return "restored";
      case "conflict":
        return "conflict";
      case "purged":
        return "purged";
    }
  }

  private report(jobId: string): OperationReport {
    return { jobId, files: this.publicFiles(jobId) };
  }
}
