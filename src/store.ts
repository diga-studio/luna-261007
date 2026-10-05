import { DatabaseSync } from "node:sqlite";
import { TaskStatus } from "./types";

export interface TaskRow {
  requestId: string;
  prompt: string;
  count: number;
  status: TaskStatus;
  nextIndex: number;
  createdAt: number;
}

interface RawTaskRow {
  request_id: string;
  prompt: string;
  count: number;
  status: string;
  next_index: number;
  created_at: number;
}

function toTaskRow(raw: RawTaskRow): TaskRow {
  return {
    requestId: raw.request_id,
    prompt: raw.prompt,
    count: raw.count,
    status: raw.status as TaskStatus,
    nextIndex: raw.next_index,
    createdAt: raw.created_at,
  };
}

/** SQLite-backed metadata store for tasks and per-image checkpoints. */
export class Store {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        request_id TEXT PRIMARY KEY,
        prompt TEXT NOT NULL,
        count INTEGER NOT NULL,
        status TEXT NOT NULL,
        next_index INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS images (
        request_id TEXT NOT NULL,
        idx INTEGER NOT NULL,
        file_name TEXT NOT NULL,
        PRIMARY KEY (request_id, idx)
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  insertTask(requestId: string, prompt: string, count: number): void {
    this.db
      .prepare(
        "INSERT INTO tasks (request_id, prompt, count, status, next_index, created_at) VALUES (?, ?, ?, 'queued', 0, ?)"
      )
      .run(requestId, prompt, count, Date.now());
  }

  getTask(requestId: string): TaskRow | undefined {
    const row = this.db
      .prepare("SELECT * FROM tasks WHERE request_id = ?")
      .get(requestId);
    return row === undefined ? undefined : toTaskRow(row as unknown as RawTaskRow);
  }

  nextQueuedTask(): TaskRow | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM tasks WHERE status = 'queued' ORDER BY created_at ASC, request_id ASC LIMIT 1"
      )
      .get();
    return row === undefined ? undefined : toTaskRow(row as unknown as RawTaskRow);
  }

  setStatus(requestId: string, status: TaskStatus): void {
    this.db
      .prepare("UPDATE tasks SET status = ? WHERE request_id = ?")
      .run(status, requestId);
  }

  /** Atomically record one finished image and advance the checkpoint. */
  checkpointImage(
    requestId: string,
    index: number,
    fileName: string,
    expectedNextIndex: number
  ): void {
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare("INSERT INTO images (request_id, idx, file_name) VALUES (?, ?, ?)")
        .run(requestId, index, fileName);
      const result = this.db
        .prepare(
          "UPDATE tasks SET next_index = ? WHERE request_id = ? AND next_index = ?"
        )
        .run(index + 1, requestId, expectedNextIndex);
      if (result.changes !== 1) {
        throw new Error(
          `checkpoint guard failed for task ${requestId} at index ${index}`
        );
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  imageFileNames(requestId: string): string[] {
    const rows = this.db
      .prepare("SELECT file_name FROM images WHERE request_id = ? ORDER BY idx ASC")
      .all(requestId);
    return rows.map((row) => row.file_name as string);
  }
}
