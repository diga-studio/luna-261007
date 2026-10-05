import { DatabaseSync } from "node:sqlite";

export type StoredFileStatus =
  | "pending"
  | "claimed"
  | "cleaned"
  | "restoring"
  | "restored"
  | "conflict"
  | "purging"
  | "purged";

export interface JobRow {
  jobId: string;
  receivedAt: number;
  expiresAt: number;
}

export interface FileRow {
  jobId: string;
  path: string;
  status: StoredFileStatus;
  storedName: string | null;
}

export type OpKind = "clean" | "undo" | "reclaim";

export interface OpRow {
  jobId: string;
  kind: OpKind;
  startedAt: number;
  done: boolean;
}

export class JobDatabase {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        job_id TEXT PRIMARY KEY,
        received_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS files (
        job_id TEXT NOT NULL,
        path TEXT NOT NULL,
        status TEXT NOT NULL,
        stored_name TEXT,
        seq INTEGER NOT NULL,
        PRIMARY KEY (job_id, path)
      );
      CREATE TABLE IF NOT EXISTS ops (
        job_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        done INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (job_id, kind)
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  getJob(jobId: string): JobRow | null {
    const row = this.db
      .prepare("SELECT job_id, received_at, expires_at FROM jobs WHERE job_id = ?")
      .get(jobId) as { job_id: string; received_at: number; expires_at: number } | undefined;
    if (!row) return null;
    return { jobId: row.job_id, receivedAt: row.received_at, expiresAt: row.expires_at };
  }

  createJobIfAbsent(jobId: string, receivedAt: number, expiresAt: number): JobRow {
    this.db
      .prepare("INSERT OR IGNORE INTO jobs (job_id, received_at, expires_at) VALUES (?, ?, ?)")
      .run(jobId, receivedAt, expiresAt);
    const job = this.getJob(jobId);
    if (!job) throw new Error("failed to create job");
    return job;
  }

  addFilesIfAbsent(jobId: string, paths: string[]): void {
    const stmt = this.db.prepare(
      "INSERT OR IGNORE INTO files (job_id, path, status, stored_name, seq) VALUES (?, ?, 'pending', NULL, ?)",
    );
    let seq = this.nextSeq(jobId);
    for (const path of paths) {
      stmt.run(jobId, path, seq);
      seq += 1;
    }
  }

  private nextSeq(jobId: string): number {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(seq) + 1, 0) AS next FROM files WHERE job_id = ?")
      .get(jobId) as { next: number };
    return row.next;
  }

  listFiles(jobId: string): FileRow[] {
    const rows = this.db
      .prepare(
        "SELECT job_id, path, status, stored_name FROM files WHERE job_id = ? ORDER BY seq",
      )
      .all(jobId) as { job_id: string; path: string; status: string; stored_name: string | null }[];
    return rows.map((row) => ({
      jobId: row.job_id,
      path: row.path,
      status: row.status as StoredFileStatus,
      storedName: row.stored_name,
    }));
  }

  setFileStatus(jobId: string, path: string, status: StoredFileStatus, storedName?: string | null): void {
    if (storedName === undefined) {
      this.db
        .prepare("UPDATE files SET status = ? WHERE job_id = ? AND path = ?")
        .run(status, jobId, path);
    } else {
      this.db
        .prepare("UPDATE files SET status = ?, stored_name = ? WHERE job_id = ? AND path = ?")
        .run(status, storedName, jobId, path);
    }
  }

  beginOp(jobId: string, kind: OpKind, startedAt: number): OpRow {
    this.db
      .prepare("INSERT OR IGNORE INTO ops (job_id, kind, started_at, done) VALUES (?, ?, ?, 0)")
      .run(jobId, kind, startedAt);
    return this.getOp(jobId, kind)!;
  }

  getOp(jobId: string, kind: OpKind): OpRow | null {
    const row = this.db
      .prepare("SELECT job_id, kind, started_at, done FROM ops WHERE job_id = ? AND kind = ?")
      .get(jobId, kind) as
      | { job_id: string; kind: string; started_at: number; done: number }
      | undefined;
    if (!row) return null;
    return {
      jobId: row.job_id,
      kind: row.kind as OpKind,
      startedAt: row.started_at,
      done: row.done !== 0,
    };
  }

  completeOp(jobId: string, kind: OpKind): void {
    this.db
      .prepare("UPDATE ops SET done = 1 WHERE job_id = ? AND kind = ?")
      .run(jobId, kind);
  }

  restartOp(jobId: string, kind: OpKind, startedAt: number): void {
    this.db
      .prepare("UPDATE ops SET done = 0, started_at = ? WHERE job_id = ? AND kind = ?")
      .run(startedAt, jobId, kind);
  }

  listJobsWithIncompleteOps(): { jobId: string; kind: OpKind; startedAt: number }[] {
    const rows = this.db
      .prepare("SELECT job_id, kind, started_at FROM ops WHERE done = 0 ORDER BY started_at")
      .all() as { job_id: string; kind: string; started_at: number }[];
    return rows.map((row) => ({
      jobId: row.job_id,
      kind: row.kind as OpKind,
      startedAt: row.started_at,
    }));
  }

  listStoredNames(): string[] {
    const rows = this.db
      .prepare("SELECT DISTINCT stored_name FROM files WHERE stored_name IS NOT NULL")
      .all() as { stored_name: string }[];
    return rows.map((row) => row.stored_name);
  }

  listJobIds(): string[] {
    const rows = this.db.prepare("SELECT job_id FROM jobs").all() as { job_id: string }[];
    return rows.map((row) => row.job_id);
  }
}
