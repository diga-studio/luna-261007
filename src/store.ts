import { DatabaseSync } from "node:sqlite";
import type { TaskStatus } from "./types.ts";

export interface TaskRow {
  requestId: string;
  prompt: string;
  count: number;
  status: TaskStatus;
  nextIndex: number;
  createdAt: number;
}

export interface ImageRow {
  requestId: string;
  idx: number;
  path: string;
}

/** SQLite-backed persistence for tasks and per-image checkpoints. */
export class Store {
  private db: DatabaseSync;

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
        path TEXT NOT NULL,
        PRIMARY KEY (request_id, idx)
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  insertTask(_row: TaskRow): void {
    this.db
      .prepare(
        `INSERT INTO tasks (request_id, prompt, count, status, next_index, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(_row.requestId, _row.prompt, _row.count, _row.status, _row.nextIndex, _row.createdAt);
  }

  getTask(_requestId: string): TaskRow | null {
    const row = this.db
      .prepare(`SELECT * FROM tasks WHERE request_id = ?`)
      .get(_requestId) as Record<string, unknown> | undefined;
    return row ? toTaskRow(row) : null;
  }

  nextQueuedTask(): TaskRow | null {
    const row = this.db
      .prepare(`SELECT * FROM tasks WHERE status = 'queued' ORDER BY created_at ASC, rowid ASC LIMIT 1`)
      .get() as Record<string, unknown> | undefined;
    return row ? toTaskRow(row) : null;
  }

  updateStatus(_requestId: string, _status: TaskStatus): void {
    this.db
      .prepare(`UPDATE tasks SET status = ? WHERE request_id = ?`)
      .run(_status, _requestId);
  }

  /** Checkpoint: record image row and advance next_index atomically. */
  checkpointImage(_requestId: string, _idx: number, _path: string): void {
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(`INSERT INTO images (request_id, idx, path) VALUES (?, ?, ?)`)
        .run(_requestId, _idx, _path);
      this.db
        .prepare(`UPDATE tasks SET next_index = ? WHERE request_id = ?`)
        .run(_idx + 1, _requestId);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  listImages(_requestId: string): ImageRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM images WHERE request_id = ? ORDER BY idx ASC`)
      .all(_requestId) as unknown as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      requestId: r.request_id as string,
      idx: r.idx as number,
      path: r.path as string,
    }));
  }

  countImages(_requestId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM images WHERE request_id = ?`)
      .get(_requestId) as { n: number };
    return row.n;
  }
}

function toTaskRow(row: Record<string, unknown>): TaskRow {
  return {
    requestId: row.request_id as string,
    prompt: row.prompt as string,
    count: row.count as number,
    status: row.status as TaskStatus,
    nextIndex: row.next_index as number,
    createdAt: row.created_at as number,
  };
}
