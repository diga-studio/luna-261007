import { DatabaseSync } from "node:sqlite";
import type { EntryState, JobEntryView, JobView } from "./types.js";

export interface JobRow {
  jobId: string;
  receivedAt: number;
}

export interface EntryRow {
  jobId: string;
  seq: number;
  path: string;
  state: EntryState;
}

export interface OpRow {
  jobId: string;
  op: "undo" | "reclaim";
  startedAt: number;
  done: boolean;
}

/**
 * SQLite persistence layer. Every mutation is committed immediately (autocommit)
 * so a process crash can only lose the single in-flight statement.
 */
export class JobStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = FULL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        job_id TEXT PRIMARY KEY,
        received_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS entries (
        job_id TEXT NOT NULL REFERENCES jobs(job_id),
        seq INTEGER NOT NULL,
        path TEXT NOT NULL,
        state TEXT NOT NULL,
        PRIMARY KEY (job_id, seq)
      );
      CREATE TABLE IF NOT EXISTS ops (
        job_id TEXT NOT NULL REFERENCES jobs(job_id),
        op TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        done INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (job_id, op)
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  /** Insert job + entries atomically. Returns false if the job already exists. */
  createJob(jobId: string, receivedAt: number, paths: string[]): boolean {
    this.db.exec("BEGIN");
    try {
      const existing = this.db
        .prepare("SELECT job_id FROM jobs WHERE job_id = ?")
        .get(jobId);
      if (existing) {
        this.db.exec("ROLLBACK");
        return false;
      }
      this.db
        .prepare("INSERT INTO jobs (job_id, received_at) VALUES (?, ?)")
        .run(jobId, receivedAt);
      const insertEntry = this.db.prepare(
        "INSERT INTO entries (job_id, seq, path, state) VALUES (?, ?, ?, 'pending')",
      );
      paths.forEach((p, i) => {
        insertEntry.run(jobId, i, p);
      });
      this.db.exec("COMMIT");
      return true;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  getJob(jobId: string): JobRow | undefined {
    const row = this.db
      .prepare("SELECT job_id, received_at FROM jobs WHERE job_id = ?")
      .get(jobId) as { job_id: string; received_at: number } | undefined;
    return row
      ? { jobId: row.job_id, receivedAt: Number(row.received_at) }
      : undefined;
  }

  listJobs(): JobRow[] {
    const rows = this.db
      .prepare("SELECT job_id, received_at FROM jobs ORDER BY received_at, job_id")
      .all() as unknown as { job_id: string; received_at: number }[];
    return rows.map((r) => ({ jobId: r.job_id, receivedAt: Number(r.received_at) }));
  }

  listEntries(jobId: string): EntryRow[] {
    const rows = this.db
      .prepare(
        "SELECT job_id, seq, path, state FROM entries WHERE job_id = ? ORDER BY seq",
      )
      .all(jobId) as unknown as {
      job_id: string;
      seq: number;
      path: string;
      state: EntryState;
    }[];
    return rows.map((r) => ({
      jobId: r.job_id,
      seq: r.seq,
      path: r.path,
      state: r.state,
    }));
  }

  setEntryState(jobId: string, seq: number, state: EntryState): void {
    this.db
      .prepare("UPDATE entries SET state = ? WHERE job_id = ? AND seq = ?")
      .run(state, jobId, seq);
  }

  /** Record that an undo/reclaim operation was accepted at startedAt. Idempotent. */
  beginOp(jobId: string, op: "undo" | "reclaim", startedAt: number): OpRow {
    this.db
      .prepare(
        "INSERT INTO ops (job_id, op, started_at, done) VALUES (?, ?, ?, 0) " +
          "ON CONFLICT (job_id, op) DO NOTHING",
      )
      .run(jobId, op, startedAt);
    const row = this.getOp(jobId, op);
    if (!row) throw new Error(`failed to begin op ${op} for ${jobId}`);
    return row;
  }

  finishOp(jobId: string, op: "undo" | "reclaim"): void {
    this.db
      .prepare("UPDATE ops SET done = 1 WHERE job_id = ? AND op = ?")
      .run(jobId, op);
  }

  /** Re-arm a finished op for a fresh initiation (e.g. retrying conflicts). */
  resetOp(jobId: string, op: "undo" | "reclaim", startedAt: number): OpRow {
    this.db
      .prepare("UPDATE ops SET done = 0, started_at = ? WHERE job_id = ? AND op = ?")
      .run(startedAt, jobId, op);
    const row = this.getOp(jobId, op);
    if (!row) throw new Error(`failed to reset op ${op} for ${jobId}`);
    return row;
  }

  /** Ops that were accepted but never finished (crash interrupted them). */
  listUnfinishedOps(): OpRow[] {
    const rows = this.db
      .prepare(
        "SELECT job_id, op, started_at, done FROM ops WHERE done = 0 ORDER BY started_at",
      )
      .all() as unknown as {
      job_id: string;
      op: "undo" | "reclaim";
      started_at: number;
      done: number;
    }[];
    return rows.map((r) => ({
      jobId: r.job_id,
      op: r.op,
      startedAt: Number(r.started_at),
      done: r.done !== 0,
    }));
  }

  getOp(jobId: string, op: "undo" | "reclaim"): OpRow | undefined {
    const row = this.db
      .prepare(
        "SELECT job_id, op, started_at, done FROM ops WHERE job_id = ? AND op = ?",
      )
      .get(jobId, op) as
      | { job_id: string; op: "undo" | "reclaim"; started_at: number; done: number }
      | undefined;
    return row
      ? {
          jobId: row.job_id,
          op: row.op,
          startedAt: Number(row.started_at),
          done: row.done !== 0,
        }
      : undefined;
  }

  toJobView(job: JobRow, entries: EntryRow[], deadline: number): JobView {
    return {
      jobId: job.jobId,
      receivedAt: job.receivedAt,
      deadline,
      entries: entries.map(
        (e): JobEntryView => ({ path: e.path, state: e.state }),
      ),
    };
  }
}
