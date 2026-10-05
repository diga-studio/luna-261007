import * as fs from "node:fs";
import * as path from "node:path";
import { JobStore } from "./db.js";
import type { EntryRow } from "./db.js";
import {
  MAX_PATHS_PER_JOB,
  RETENTION_MS,
  type EntryState,
  type FaultEvent,
  type JobView,
  type PurgeWaveOptions,
} from "./types.js";

const RETAINED_STATES: ReadonlySet<EntryState> = new Set([
  "purged",
  "conflict",
]);

/**
 * PurgeWave: undoable batch file purge.
 *
 * Construction runs crash recovery synchronously; afterwards the instance
 * accepts operations. All public methods execute sequentially (the library
 * itself is single-threaded; callers must not invoke concurrently).
 *
 * Crash-safety protocol: every filesystem mutation is immediately followed by
 * its own committed record update, and recovery reconciles records against
 * the real filesystem before resuming interrupted work.
 */
export class PurgeWave {
  private readonly store: JobStore;
  private readonly blobsDir: string;
  private readonly now: () => number;
  private readonly faultHook?: (event: FaultEvent) => void;

  constructor(options: PurgeWaveOptions) {
    if (!options.storageDir) throw new Error("storageDir is required");
    const storageDir = path.resolve(options.storageDir);
    this.blobsDir = path.join(storageDir, "blobs");
    fs.mkdirSync(this.blobsDir, { recursive: true });
    this.now = options.now ?? Date.now;
    this.faultHook = options.faultHook;
    this.store = new JobStore(path.join(storageDir, "purgewave.db"));
    try {
      this.recover();
    } catch (err) {
      this.store.close();
      throw err;
    }
  }

  /** Accept (or idempotently re-accept) a purge job, then execute it. */
  purge(jobId: string, paths: string[]): JobView {
    this.assertJobId(jobId);
    if (!Array.isArray(paths)) throw new Error("paths must be an array");
    if (!this.store.getJob(jobId)) {
      const deduped = [...new Set(paths.map((p) => path.resolve(p)))];
      if (deduped.length === 0) throw new Error("paths must not be empty");
      if (deduped.length > MAX_PATHS_PER_JOB) {
        throw new Error(`a job accepts at most ${MAX_PATHS_PER_JOB} paths`);
      }
      // Atomic accept: a crash before this commit means "never received".
      this.store.createJob(jobId, this.now(), deduped);
    }
    // Re-submission with the same id reuses the stored list and progress;
    // files that later appeared at the original paths are never re-purged.
    this.runPurge(jobId, "purge");
    return this.mustView(jobId);
  }

  /** Restore retained content to original paths. Idempotent. */
  undo(jobId: string): JobView {
    const job = this.store.getJob(this.assertJobId(jobId));
    if (!job) throw new Error(`unknown job: ${jobId}`);
    const deadline = job.receivedAt + RETENTION_MS;
    let op = this.store.getOp(jobId, "undo");
    if (!op) {
      if (this.now() >= deadline) {
        throw new Error(`job ${jobId} retention expired; undo is no longer allowed`);
      }
      // The expiry judgment is pinned to this first acceptance; a crash and
      // retry afterwards resumes with the same judgment even past deadline.
      op = this.store.beginOp(jobId, "undo", this.now());
    } else if (op.done) {
      // A previous undo finished; this call is a new initiation. Only
      // conflict entries remain retriable, and only before the deadline.
      const retriable = this.store
        .listEntries(jobId)
        .some((e) => e.state === "conflict");
      if (!retriable) return this.mustView(jobId);
      if (this.now() >= deadline) {
        throw new Error(`job ${jobId} retention expired; undo is no longer allowed`);
      }
      op = this.store.resetOp(jobId, "undo", this.now());
    }
    this.runUndo(jobId, "undo");
    this.store.finishOp(jobId, "undo");
    return this.mustView(jobId);
  }

  /** Permanently delete retained content whose retention has expired. */
  reclaim(jobId: string): JobView {
    const job = this.store.getJob(this.assertJobId(jobId));
    if (!job) throw new Error(`unknown job: ${jobId}`);
    let op = this.store.getOp(jobId, "reclaim");
    if (!op) {
      if (this.now() < job.receivedAt + RETENTION_MS) {
        return this.mustView(jobId); // not expired yet: nothing to do
      }
      op = this.store.beginOp(jobId, "reclaim", this.now());
    }
    if (!op.done) {
      this.runReclaim(jobId, "reclaim");
      this.store.finishOp(jobId, "reclaim");
    }
    return this.mustView(jobId);
  }

  /** Inspect a job; undefined when the id was never received. */
  getJob(jobId: string): JobView | undefined {
    const job = this.store.getJob(jobId);
    if (!job) return undefined;
    return this.store.toJobView(
      job,
      this.store.listEntries(jobId),
      job.receivedAt + RETENTION_MS,
    );
  }

  close(): void {
    this.store.close();
  }

  // ---- internals -------------------------------------------------------

  private assertJobId(jobId: string): string {
    if (typeof jobId !== "string" || jobId.length === 0) {
      throw new Error("jobId must be a non-empty string");
    }
    return jobId;
  }

  private mustView(jobId: string): JobView {
    const view = this.getJob(jobId);
    if (!view) throw new Error(`unknown job: ${jobId}`);
    return view;
  }

  private blobPath(jobId: string, seq: number): string {
    return path.join(this.blobsDir, encodeURIComponent(jobId), String(seq));
  }

  private fault(op: FaultEvent["op"], kind: FaultEvent["kind"], jobId: string, p?: string): void {
    this.faultHook?.({ op, kind, jobId, path: p });
  }

  private runPurge(jobId: string, op: FaultEvent["op"]): void {
    const entries = this.store.listEntries(jobId);
    const pending = entries.filter((e) => e.state === "pending");
    if (pending.length === 0) return;
    fs.mkdirSync(path.join(this.blobsDir, encodeURIComponent(jobId)), {
      recursive: true,
    });
    for (const entry of pending) {
      const blob = this.blobPath(jobId, entry.seq);
      if (fs.existsSync(blob)) {
        // Rename landed but the record commit was lost to a crash.
        this.store.setEntryState(jobId, entry.seq, "purged");
        this.fault(op, "record", jobId, entry.path);
        continue;
      }
      const stat = fs.lstatSync(entry.path, { throwIfNoEntry: false });
      if (!stat?.isFile()) {
        this.store.setEntryState(jobId, entry.seq, "missing");
        this.fault(op, "record", jobId, entry.path);
        continue;
      }
      fs.renameSync(entry.path, blob);
      this.fault(op, "file", jobId, entry.path);
      this.store.setEntryState(jobId, entry.seq, "purged");
      this.fault(op, "record", jobId, entry.path);
    }
  }

  private runUndo(jobId: string, op: FaultEvent["op"]): void {
    for (const entry of this.store.listEntries(jobId)) {
      if (!RETAINED_STATES.has(entry.state)) continue;
      const blob = this.blobPath(jobId, entry.seq);
      if (!fs.existsSync(blob)) {
        // Rename-back landed but the record commit was lost to a crash.
        if (fs.existsSync(entry.path)) {
          this.store.setEntryState(jobId, entry.seq, "restored");
          this.fault(op, "record", jobId, entry.path);
        }
        continue;
      }
      if (fs.existsSync(entry.path)) {
        // Occupied by anything (file or directory): never overwrite.
        this.store.setEntryState(jobId, entry.seq, "conflict");
        this.fault(op, "record", jobId, entry.path);
        continue;
      }
      try {
        fs.renameSync(blob, entry.path);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          // Parent directory vanished: cannot restore now, keep content.
          this.store.setEntryState(jobId, entry.seq, "conflict");
          this.fault(op, "record", jobId, entry.path);
          continue;
        }
        throw err;
      }
      this.fault(op, "file", jobId, entry.path);
      this.store.setEntryState(jobId, entry.seq, "restored");
      this.fault(op, "record", jobId, entry.path);
    }
    this.removeBlobDirIfEmpty(jobId);
  }

  private runReclaim(jobId: string, op: FaultEvent["op"]): void {
    for (const entry of this.store.listEntries(jobId)) {
      if (!RETAINED_STATES.has(entry.state)) continue;
      const blob = this.blobPath(jobId, entry.seq);
      // Only the retained copy is removed; the original path is never touched.
      fs.rmSync(blob, { force: true });
      this.fault(op, "file", jobId, entry.path);
      this.store.setEntryState(jobId, entry.seq, "reclaimed");
      this.fault(op, "record", jobId, entry.path);
    }
    this.removeBlobDirIfEmpty(jobId);
  }

  private removeBlobDirIfEmpty(jobId: string): void {
    const dir = path.join(this.blobsDir, encodeURIComponent(jobId));
    try {
      fs.rmdirSync(dir);
    } catch {
      // Not empty or absent: fine.
    }
  }

  /**
   * Runs before any new operation is accepted or any job result returned.
   * Reconciles records with the filesystem, resumes interrupted work, and
   * removes retained content that cannot be attributed to a job entry.
   */
  private recover(): void {
    const jobs = this.store.listJobs();
    for (const job of jobs) {
      for (const entry of this.store.listEntries(job.jobId)) {
        this.reconcileEntry(job.jobId, entry);
      }
    }
    // Interrupted purges first: they precede any undo/reclaim in real time.
    for (const job of jobs) {
      this.runPurge(job.jobId, "recover");
    }
    for (const op of this.store.listUnfinishedOps()) {
      if (op.op === "undo") {
        this.runUndo(op.jobId, "recover");
      } else {
        this.runReclaim(op.jobId, "recover");
      }
      this.store.finishOp(op.jobId, op.op);
    }
    this.sweepOrphanBlobs();
  }

  private reconcileEntry(jobId: string, entry: EntryRow): void {
    const blobExists = fs.existsSync(this.blobPath(jobId, entry.seq));
    switch (entry.state) {
      case "pending":
        if (blobExists) this.store.setEntryState(jobId, entry.seq, "purged");
        break;
      case "purged":
      case "conflict":
        if (!blobExists) {
          // The blob is gone: the file op landed but its record did not.
          // Restore leaves content at the original path; reclaim leaves none.
          this.store.setEntryState(
            jobId,
            entry.seq,
            fs.existsSync(entry.path) ? "restored" : "reclaimed",
          );
        }
        break;
      case "restored":
      case "reclaimed":
        if (blobExists) fs.rmSync(this.blobPath(jobId, entry.seq), { force: true });
        break;
      case "missing":
        break;
    }
  }

  private sweepOrphanBlobs(): void {
    const retained = new Map<string, Set<string>>();
    for (const job of this.store.listJobs()) {
      const seqs = new Set<string>();
      for (const entry of this.store.listEntries(job.jobId)) {
        if (RETAINED_STATES.has(entry.state)) seqs.add(String(entry.seq));
      }
      retained.set(encodeURIComponent(job.jobId), seqs);
    }
    for (const dirName of fs.readdirSync(this.blobsDir)) {
      const dir = path.join(this.blobsDir, dirName);
      if (!fs.statSync(dir).isDirectory()) continue;
      const seqs = retained.get(dirName);
      if (!seqs) {
        fs.rmSync(dir, { recursive: true, force: true });
        continue;
      }
      for (const file of fs.readdirSync(dir)) {
        if (!seqs.has(file)) fs.rmSync(path.join(dir, file), { force: true });
      }
      if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
    }
  }
}
