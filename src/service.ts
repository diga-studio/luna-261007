import { DatabaseSync } from "node:sqlite";
import { createSchema } from "./schema.js";
import type {
  Application,
  ApplicationStatus,
  ClassDef,
  ClassStatus,
  OperationResult,
  StudentStatus,
} from "./types.js";

interface CandidateRow {
  seq: number;
  student_id: string;
  class_id: string;
  start_min: number;
  end_min: number;
}

interface ApplicationRow {
  seq: number;
  student_id: string;
  class_id: string;
  status: ApplicationStatus;
}

function toApplication(row: ApplicationRow): Application {
  return {
    seq: row.seq,
    studentId: row.student_id,
    classId: row.class_id,
    status: row.status,
  };
}

/**
 * 选课与候补回填服务。
 *
 * 并发模型：node:sqlite 为同步驱动，每个写操作（撤销 + 全部回填）
 * 包在单个 IMMEDIATE 事务中，请求在事件循环上天然串行，
 * 查询不可能看到事务中间状态。
 *
 * 回填不变量：任何可见状态下，不存在"班级有空位且学生无时间冲突"的候补。
 * 每次写操作前不变量成立，操作只需修复它可能破坏的部分：
 * - enroll(s, c)：不释放空位、不消除冲突，唯一可能新增的
 *   可晋级候补是新申请 (s, c) 本身；
 * - drop(s, c)：仅当撤销的是已选时才释放 c 的空位并消除 s 的冲突，
 *   资格可能变化的只有"c 班的候补"与"s 的候补"；
 * 因此写操作做定向回填即可恢复全局不变量，无需全表扫描。
 */
export class EnrollmentService {
  private readonly db: DatabaseSync;

  constructor(dbPath: string, classes: ClassDef[]) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    createSchema(this.db);

    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO classes (class_id, capacity, start_min, end_min) VALUES (?, ?, ?, ?)",
    );
    this.inTransaction(() => {
      for (const c of classes) {
        if (!Number.isInteger(c.capacity) || c.capacity < 1 || c.capacity > 30) {
          throw new RangeError(`class ${c.classId}: capacity must be 1..30`);
        }
        if (
          !Number.isInteger(c.startMin) ||
          !Number.isInteger(c.endMin) ||
          c.endMin <= c.startMin
        ) {
          throw new RangeError(`class ${c.classId}: invalid time range`);
        }
        insert.run(c.classId, c.capacity, c.startMin, c.endMin);
      }
    });
  }

  /** 学生申请选某班：无有效申请则新增候补并回填，否则不变。 */
  enroll(studentId: string, classId: string): OperationResult {
    return this.inTransaction(() => {
      this.assertClassExists(classId);
      const existing = this.findApplication(studentId, classId);
      if (existing) {
        return { status: existing.status, seq: existing.seq };
      }
      this.db
        .prepare("INSERT INTO applications (student_id, class_id, status) VALUES (?, ?, 'waitlisted')")
        .run(studentId, classId);
      this.backfillTargeted(classId, studentId);
      const after = this.findApplication(studentId, classId);
      return { status: after ? after.status : null, seq: after ? after.seq : null };
    });
  }

  /** 学生退某班：撤销有效申请（已选或候补）并回填；无有效申请则不变。 */
  drop(studentId: string, classId: string): OperationResult {
    return this.inTransaction(() => {
      const existing = this.findApplication(studentId, classId);
      if (!existing) {
        return { status: null, seq: null };
      }
      if (existing.status === "enrolled") {
        this.db
          .prepare("UPDATE classes SET enrolled_count = enrolled_count - 1 WHERE class_id = ?")
          .run(classId);
        this.db.prepare("DELETE FROM applications WHERE seq = ?").run(existing.seq);
        // 释放了空位、消除了该学生的冲突，需定向回填
        this.backfillTargeted(classId, studentId);
      } else {
        // 撤销候补不释放空位也不消除冲突，不变量天然保持
        this.db.prepare("DELETE FROM applications WHERE seq = ?").run(existing.seq);
      }
      return { status: null, seq: existing.seq };
    });
  }

  /** 查询学生当前已选与候补。 */
  getStudentStatus(studentId: string): StudentStatus {
    const rows = this.db
      .prepare(
        "SELECT seq, student_id, class_id, status FROM applications WHERE student_id = ? ORDER BY seq",
      )
      .all(studentId) as unknown as ApplicationRow[];
    const enrolled: Application[] = [];
    const waitlisted: Application[] = [];
    for (const row of rows) {
      (row.status === "enrolled" ? enrolled : waitlisted).push(toApplication(row));
    }
    return { studentId, enrolled, waitlisted };
  }

  /** 查询班级当前已选与候补。 */
  getClassStatus(classId: string): ClassStatus {
    const classRow = this.db
      .prepare("SELECT capacity, enrolled_count FROM classes WHERE class_id = ?")
      .get(classId) as { capacity: number; enrolled_count: number } | undefined;
    if (!classRow) {
      throw new Error(`unknown class: ${classId}`);
    }
    const rows = this.db
      .prepare(
        "SELECT seq, student_id, class_id, status FROM applications WHERE class_id = ? ORDER BY seq",
      )
      .all(classId) as unknown as ApplicationRow[];
    const enrolled: Application[] = [];
    const waitlisted: Application[] = [];
    for (const row of rows) {
      (row.status === "enrolled" ? enrolled : waitlisted).push(toApplication(row));
    }
    return {
      classId,
      capacity: classRow.capacity,
      enrolledCount: classRow.enrolled_count,
      enrolled,
      waitlisted,
    };
  }

  /**
   * 批量载入既有申请（用于报名轮次初始化/数据迁移）。
   * 单事务插入，最后做一次全量回填建立不变量。
   */
  bulkLoad(entries: ReadonlyArray<{ studentId: string; classId: string }>): void {
    const insert = this.db.prepare(
      "INSERT INTO applications (student_id, class_id, status) VALUES (?, ?, 'waitlisted')",
    );
    this.inTransaction(() => {
      for (const e of entries) {
        insert.run(e.studentId, e.classId);
      }
      this.backfillFull();
    });
  }

  /** 全轮次统计：已选与候补数量。 */
  stats(): { enrolled: number; waitlisted: number } {
    const rows = this.db
      .prepare('SELECT status, COUNT(*) AS n FROM applications GROUP BY status')
      .all() as unknown as Array<{ status: string; n: number }>;
    let enrolled = 0;
    let waitlisted = 0;
    for (const r of rows) {
      if (r.status === 'enrolled') enrolled = r.n;
      else if (r.status === 'waitlisted') waitlisted = r.n;
    }
    return { enrolled, waitlisted };
  }

  close(): void {
    this.db.close();
  }

  private inTransaction<T>(fn: () => T): T {
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

  private assertClassExists(classId: string): void {
    const row = this.db
      .prepare("SELECT 1 AS ok FROM classes WHERE class_id = ?")
      .get(classId);
    if (!row) {
      throw new Error(`unknown class: ${classId}`);
    }
  }

  private findApplication(studentId: string, classId: string): ApplicationRow | undefined {
    return this.db
      .prepare(
        "SELECT seq, student_id, class_id, status FROM applications WHERE student_id = ? AND class_id = ?",
      )
      .get(studentId, classId) as ApplicationRow | undefined;
  }

  /** 晋级一条候补：置为已选并占用空位。 */
  private promote(seq: number, classId: string): void {
    this.db
      .prepare("UPDATE applications SET status = 'enrolled' WHERE seq = ?")
      .run(seq);
    this.db
      .prepare("UPDATE classes SET enrolled_count = enrolled_count + 1 WHERE class_id = ?")
      .run(classId);
  }

  /** 学生已选班级与候选时段 [startMin, endMin) 是否冲突。 */
  private hasConflict(studentId: string, startMin: number, endMin: number): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 AS ok
         FROM applications a
         JOIN classes c ON c.class_id = a.class_id
         WHERE a.student_id = ?
           AND a.status = 'enrolled'
           AND c.start_min < ?
           AND c.end_min > ?
         LIMIT 1`,
      )
      .get(studentId, endMin, startMin);
    return row !== undefined;
  }

  /**
   * 定向回填：只扫描"指定班级"与"指定学生"的候补。
   * 按受理序号升序单趟处理；晋级只会减少空位、增加冲突，
   * 被跳过的候补在本趟内不可能重新具备资格。
   */
  private backfillTargeted(classId: string, studentId: string): void {
    const candidates = this.db
      .prepare(
        `SELECT seq, student_id, class_id, start_min, end_min FROM (
           SELECT a.seq AS seq, a.student_id AS student_id, a.class_id AS class_id,
                  c.start_min AS start_min, c.end_min AS end_min
           FROM applications a
           JOIN classes c ON c.class_id = a.class_id
           WHERE a.status = 'waitlisted'
             AND a.class_id = ?
             AND c.enrolled_count < c.capacity
           UNION
           SELECT a.seq, a.student_id, a.class_id, c.start_min, c.end_min
           FROM applications a
           JOIN classes c ON c.class_id = a.class_id
           WHERE a.status = 'waitlisted'
             AND a.student_id = ?
             AND c.enrolled_count < c.capacity
         )
         ORDER BY seq`,
      )
      .all(classId, studentId) as unknown as CandidateRow[];
    const seatLeft = this.db.prepare(
      "SELECT capacity - enrolled_count AS left_seats FROM classes WHERE class_id = ?",
    );
    for (const cand of candidates) {
      const seats = seatLeft.get(cand.class_id) as { left_seats: number };
      if (seats.left_seats <= 0) continue;
      if (this.hasConflict(cand.student_id, cand.start_min, cand.end_min)) continue;
      this.promote(cand.seq, cand.class_id);
    }
  }

  /**
   * 全量回填（仅批量载入后调用一次）：按受理序号升序扫描所有
   * "班级尚有空位"的候补，晋级无冲突者，直到无可晋级。
   */
  private backfillFull(): void {
    const nextCandidate = this.db.prepare(
      `SELECT a.seq, a.student_id, a.class_id, c.start_min, c.end_min
       FROM applications a
       JOIN classes c ON c.class_id = a.class_id
       WHERE a.status = 'waitlisted'
         AND a.seq > ?
         AND c.enrolled_count < c.capacity
       ORDER BY a.seq
       LIMIT 1`,
    );
    let cursor = 0;
    for (;;) {
      const candidate = nextCandidate.get(cursor) as CandidateRow | undefined;
      if (!candidate) return;
      cursor = candidate.seq;
      if (this.hasConflict(candidate.student_id, candidate.start_min, candidate.end_min)) {
        continue;
      }
      this.promote(candidate.seq, candidate.class_id);
    }
  }
}
