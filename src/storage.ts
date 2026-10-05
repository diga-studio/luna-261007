import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AttemptStatus } from './types.js';

export interface AttemptRow {
  attemptId: string;
  learnerId: string;
  operationId: string;
  startedAt: number;
  deadline: number;
  status: AttemptStatus;
}

export interface SubmissionRow {
  attemptId: string;
  operationId: string;
  answersJson: string;
  submittedAt: number;
  /** 1 = 在 deadline 前被接纳的有效提交；0 = 迟交（按超时失败处理）。 */
  valid: number;
  correctCount: number;
  totalCount: number;
  passed: number;
  certificateId: string | null;
}

interface AttemptRaw {
  attempt_id: string;
  learner_id: string;
  operation_id: string;
  started_at: number;
  deadline: number;
  status: string;
}

interface SubmissionRaw {
  attempt_id: string;
  operation_id: string;
  answers_json: string;
  submitted_at: number;
  valid: number;
  correct_count: number;
  total_count: number;
  passed: number;
  certificate_id: string | null;
}

function toAttemptRow(raw: AttemptRaw): AttemptRow {
  return {
    attemptId: raw.attempt_id,
    learnerId: raw.learner_id,
    operationId: raw.operation_id,
    startedAt: raw.started_at,
    deadline: raw.deadline,
    status: raw.status as AttemptStatus,
  };
}

function toSubmissionRow(raw: SubmissionRaw): SubmissionRow {
  return {
    attemptId: raw.attempt_id,
    operationId: raw.operation_id,
    answersJson: raw.answers_json,
    submittedAt: raw.submitted_at,
    valid: raw.valid,
    correctCount: raw.correct_count,
    totalCount: raw.total_count,
    passed: raw.passed,
    certificateId: raw.certificate_id,
  };
}

/**
 * SQLite 考核账本。所有写操作在事务内完成并同步落盘，
 * 事务提交点即崩溃一致性边界。
 */
export class Ledger {
  private readonly db: DatabaseSync;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(join(dir, 'ledger.sqlite'));
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = FULL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS attempts (
        attempt_id   TEXT PRIMARY KEY,
        learner_id   TEXT NOT NULL,
        operation_id TEXT NOT NULL UNIQUE,
        started_at   INTEGER NOT NULL,
        deadline     INTEGER NOT NULL,
        status       TEXT NOT NULL CHECK (status IN ('active', 'submitted', 'timeout'))
      );
      CREATE TABLE IF NOT EXISTS submissions (
        attempt_id     TEXT PRIMARY KEY REFERENCES attempts (attempt_id),
        operation_id   TEXT NOT NULL UNIQUE,
        answers_json   TEXT NOT NULL,
        submitted_at   INTEGER NOT NULL,
        valid          INTEGER NOT NULL,
        correct_count  INTEGER NOT NULL,
        total_count    INTEGER NOT NULL,
        passed         INTEGER NOT NULL,
        certificate_id TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_attempts_learner ON attempts (learner_id, started_at);
    `);
  }

  close(): void {
    this.db.close();
  }

  /** 在单个事务中执行；提交成功才返回，异常即回滚。 */
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  insertAttempt(row: AttemptRow): void {
    this.db
      .prepare(
        `INSERT INTO attempts (attempt_id, learner_id, operation_id, started_at, deadline, status)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(row.attemptId, row.learnerId, row.operationId, row.startedAt, row.deadline, row.status);
  }

  getAttempt(attemptId: string): AttemptRow | undefined {
    const raw = this.db
      .prepare('SELECT * FROM attempts WHERE attempt_id = ?')
      .get(attemptId) as AttemptRaw | undefined;
    return raw ? toAttemptRow(raw) : undefined;
  }

  getAttemptByOperation(operationId: string): AttemptRow | undefined {
    const raw = this.db
      .prepare('SELECT * FROM attempts WHERE operation_id = ?')
      .get(operationId) as AttemptRaw | undefined;
    return raw ? toAttemptRow(raw) : undefined;
  }

  listAttemptsByLearner(learnerId: string): AttemptRow[] {
    const raws = this.db
      .prepare('SELECT * FROM attempts WHERE learner_id = ? ORDER BY started_at ASC, attempt_id ASC')
      .all(learnerId) as unknown as AttemptRaw[];
    return raws.map(toAttemptRow);
  }

  listExpiredActiveAttempts(now: number): AttemptRow[] {
    const raws = this.db
      .prepare(`SELECT * FROM attempts WHERE status = 'active' AND deadline <= ?`)
      .all(now) as unknown as AttemptRaw[];
    return raws.map(toAttemptRow);
  }

  setAttemptStatus(attemptId: string, status: AttemptStatus): void {
    this.db.prepare('UPDATE attempts SET status = ? WHERE attempt_id = ?').run(status, attemptId);
  }

  insertSubmission(row: SubmissionRow): void {
    this.db
      .prepare(
        `INSERT INTO submissions
           (attempt_id, operation_id, answers_json, submitted_at, valid,
            correct_count, total_count, passed, certificate_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.attemptId,
        row.operationId,
        row.answersJson,
        row.submittedAt,
        row.valid,
        row.correctCount,
        row.totalCount,
        row.passed,
        row.certificateId,
      );
  }

  getSubmission(attemptId: string): SubmissionRow | undefined {
    const raw = this.db
      .prepare('SELECT * FROM submissions WHERE attempt_id = ?')
      .get(attemptId) as SubmissionRaw | undefined;
    return raw ? toSubmissionRow(raw) : undefined;
  }

  getSubmissionByOperation(operationId: string): SubmissionRow | undefined {
    const raw = this.db
      .prepare('SELECT * FROM submissions WHERE operation_id = ?')
      .get(operationId) as SubmissionRaw | undefined;
    return raw ? toSubmissionRow(raw) : undefined;
  }

  /** 所有通过且应有证书的提交，用于恢复时与证书文件对账。 */
  listCertifiedSubmissions(): SubmissionRow[] {
    const raws = this.db
      .prepare(`SELECT * FROM submissions WHERE passed = 1 AND certificate_id IS NOT NULL`)
      .all() as unknown as SubmissionRaw[];
    return raws.map(toSubmissionRow);
  }
}
