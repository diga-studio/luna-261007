import { DatabaseSync } from "node:sqlite";
import type { Answers, AttemptRecord, AttemptStatus } from "./types.js";

interface AttemptRow {
  attempt_id: string;
  learner_id: string;
  exam_id: string;
  status: string;
  started_at: number;
  deadline: number;
  submitted_at: number | null;
  answers: string | null;
  correct_count: number | null;
  total_count: number | null;
  passed: number | null;
  certificate_id: string | null;
}

function rowToAttempt(row: AttemptRow): AttemptRecord {
  return {
    attemptId: row.attempt_id,
    learnerId: row.learner_id,
    examId: row.exam_id,
    status: row.status as AttemptStatus,
    startedAt: row.started_at,
    deadline: row.deadline,
    submittedAt: row.submitted_at,
    answers: row.answers === null ? null : (JSON.parse(row.answers) as Answers),
    correctCount: row.correct_count,
    totalCount: row.total_count,
    passed: row.passed === null ? null : row.passed !== 0,
    certificateId: row.certificate_id,
  };
}

export class Ledger {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = FULL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS attempts (
        attempt_id TEXT PRIMARY KEY,
        learner_id TEXT NOT NULL,
        exam_id TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        deadline INTEGER NOT NULL,
        submitted_at INTEGER,
        answers TEXT,
        correct_count INTEGER,
        total_count INTEGER,
        passed INTEGER,
        certificate_id TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_attempts_learner ON attempts (learner_id);
      CREATE TABLE IF NOT EXISTS operations (
        method TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        result TEXT NOT NULL,
        PRIMARY KEY (method, operation_id)
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  getAttempt(attemptId: string): AttemptRecord | null {
    const row = this.db
      .prepare("SELECT * FROM attempts WHERE attempt_id = ?")
      .get(attemptId) as AttemptRow | undefined;
    return row === undefined ? null : rowToAttempt(row);
  }

  listAttemptsByLearner(learnerId: string): AttemptRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM attempts WHERE learner_id = ? ORDER BY started_at")
      .all(learnerId) as unknown as AttemptRow[];
    return rows.map(rowToAttempt);
  }

  listAllAttempts(): AttemptRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM attempts")
      .all() as unknown as AttemptRow[];
    return rows.map(rowToAttempt);
  }

  insertAttempt(attempt: AttemptRecord): void {
    this.db
      .prepare(
        `INSERT INTO attempts (
           attempt_id, learner_id, exam_id, status, started_at, deadline,
           submitted_at, answers, correct_count, total_count, passed, certificate_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        attempt.attemptId,
        attempt.learnerId,
        attempt.examId,
        attempt.status,
        attempt.startedAt,
        attempt.deadline,
        attempt.submittedAt,
        attempt.answers === null ? null : JSON.stringify(attempt.answers),
        attempt.correctCount,
        attempt.totalCount,
        attempt.passed === null ? null : attempt.passed ? 1 : 0,
        attempt.certificateId,
      );
  }

  markSubmitted(
    attemptId: string,
    submittedAt: number,
    answers: Answers,
    correctCount: number,
    totalCount: number,
    passed: boolean,
  ): void {
    this.db
      .prepare(
        `UPDATE attempts
         SET status = 'submitted', submitted_at = ?, answers = ?,
             correct_count = ?, total_count = ?, passed = ?
         WHERE attempt_id = ?`,
      )
      .run(
        submittedAt,
        JSON.stringify(answers),
        correctCount,
        totalCount,
        passed ? 1 : 0,
        attemptId,
      );
  }

  markTimeout(attemptId: string): void {
    this.db
      .prepare("UPDATE attempts SET status = 'timeout' WHERE attempt_id = ?")
      .run(attemptId);
  }

  setCertificate(attemptId: string, certificateId: string): void {
    this.db
      .prepare("UPDATE attempts SET certificate_id = ? WHERE attempt_id = ?")
      .run(certificateId, attemptId);
  }

  clearCertificate(attemptId: string): void {
    this.db
      .prepare("UPDATE attempts SET certificate_id = NULL WHERE attempt_id = ?")
      .run(attemptId);
  }

  getOperation(method: string, operationId: string): unknown | null {
    const row = this.db
      .prepare("SELECT result FROM operations WHERE method = ? AND operation_id = ?")
      .get(method, operationId) as { result: string } | undefined;
    return row === undefined ? null : (JSON.parse(row.result) as unknown);
  }

  recordOperation(method: string, operationId: string, result: unknown): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO operations (method, operation_id, result) VALUES (?, ?, ?)",
      )
      .run(method, operationId, JSON.stringify(result));
  }
}
