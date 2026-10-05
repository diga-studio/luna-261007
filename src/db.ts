import { DatabaseSync } from "node:sqlite";
import type { ClassConfig, EnrollmentRequest, RequestStatus } from "./types.js";

interface ClassRow {
  class_id: string;
  capacity: number;
  start_min: number;
  end_min: number;
}

interface RequestRow {
  seq: number;
  student_id: string;
  class_id: string;
  status: string;
}

/**
 * SQLite 持久化层：负责 schema、整库载入与申请记录的单条写透。
 * 进程内状态以内存为准，本层保证每次业务变化在同一事务内同步落盘。
 */
export class Store {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS classes (
        class_id  TEXT PRIMARY KEY,
        capacity  INTEGER NOT NULL CHECK (capacity BETWEEN 1 AND 30),
        start_min INTEGER NOT NULL,
        end_min   INTEGER NOT NULL CHECK (end_min > start_min)
      );
      CREATE TABLE IF NOT EXISTS requests (
        seq        INTEGER PRIMARY KEY AUTOINCREMENT,
        student_id TEXT NOT NULL,
        class_id   TEXT NOT NULL REFERENCES classes(class_id),
        status     TEXT NOT NULL CHECK (status IN ('enrolled', 'waitlisted'))
      );
      CREATE INDEX IF NOT EXISTS idx_requests_student ON requests(student_id);
      CREATE INDEX IF NOT EXISTS idx_requests_class ON requests(class_id);
    `);
  }

  /** 库中是否已有班级配置（用于区分新建与重开）。 */
  hasClasses(): boolean {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM classes")
      .get() as { n: number };
    return row.n > 0;
  }

  /** 写入全部班级配置（仅在建库初始化时调用）。 */
  insertClasses(classes: ClassConfig[]): void {
    const stmt = this.db.prepare(
      "INSERT INTO classes (class_id, capacity, start_min, end_min) VALUES (?, ?, ?, ?)",
    );
    this.transaction(() => {
      for (const c of classes) {
        stmt.run(c.classId, c.capacity, c.startMin, c.endMin);
      }
    });
  }

  /** 载入全部班级配置。 */
  loadClasses(): ClassConfig[] {
    const rows = this.db
      .prepare("SELECT class_id, capacity, start_min, end_min FROM classes")
      .all() as unknown as ClassRow[];
    return rows.map((r) => ({
      classId: r.class_id,
      capacity: r.capacity,
      startMin: r.start_min,
      endMin: r.end_min,
    }));
  }

  /** 载入全部有效申请。 */
  loadRequests(): EnrollmentRequest[] {
    const rows = this.db
      .prepare("SELECT seq, student_id, class_id, status FROM requests ORDER BY seq")
      .all() as unknown as RequestRow[];
    return rows.map((r) => ({
      seq: r.seq,
      studentId: r.student_id,
      classId: r.class_id,
      status: r.status as RequestStatus,
    }));
  }

  /** 当前已分配的最大受理序号（无申请时为 0）。 */
  maxSeq(): number {
    const row = this.db
      .prepare("SELECT seq FROM sqlite_sequence WHERE name = 'requests'")
      .get() as { seq: number } | undefined;
    return row?.seq ?? 0;
  }

  /** 新增一条有效申请，返回分配的受理序号。 */
  insertRequest(studentId: string, classId: string, status: RequestStatus): number {
    const info = this.db
      .prepare("INSERT INTO requests (student_id, class_id, status) VALUES (?, ?, ?)")
      .run(studentId, classId, status);
    return Number(info.lastInsertRowid);
  }

  /** 更新申请状态（enrolled/waitlisted）。 */
  updateRequestStatus(seq: number, status: RequestStatus): void {
    this.db
      .prepare("UPDATE requests SET status = ? WHERE seq = ?")
      .run(status, seq);
  }

  /** 删除一条申请（退课撤销）。 */
  deleteRequest(seq: number): void {
    this.db.prepare("DELETE FROM requests WHERE seq = ?").run(seq);
  }

  /** 在单个事务中执行一批写操作，任一步失败整体回滚。 */
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }
}
