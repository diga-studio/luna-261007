import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { Frequency, ResultStatus } from './types.js';

export interface RuleRow {
  ruleId: number;
  contractId: string;
  firstDueDate: string;
  endDate: string;
  frequency: Frequency;
}

export interface ResultAggregate {
  /** 区间内状态为免除的期次数 */
  exempted: number;
  /** 区间内完成日期不晚于到期日的期次数 */
  onTime: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS rules (
  rule_id INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id TEXT NOT NULL,
  first_due_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  frequency TEXT NOT NULL CHECK (frequency IN ('once','monthly','quarterly','yearly'))
);
CREATE TABLE IF NOT EXISTS results (
  rule_id INTEGER NOT NULL REFERENCES rules(rule_id),
  due_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('completed','exempted')),
  completed_date TEXT,
  PRIMARY KEY (rule_id, due_date)
);
`;

/** SQLite 持久化层：规则表 + 处理结果表。 */
export class Store {
  private readonly db: DatabaseSync;
  private readonly stmts = new Map<string, StatementSync>();

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec(SCHEMA);
  }

  /** 在单个事务中执行批量写入，任一失败整体回滚。 */
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

  private prepare(sql: string): StatementSync {
    let stmt = this.stmts.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.stmts.set(sql, stmt);
    }
    return stmt;
  }

  insertRule(rule: Omit<RuleRow, 'ruleId'>): number {
    const stmt = this.prepare(
      'INSERT INTO rules (contract_id, first_due_date, end_date, frequency) VALUES (?, ?, ?, ?)',
    );
    const info = stmt.run(rule.contractId, rule.firstDueDate, rule.endDate, rule.frequency);
    return Number(info.lastInsertRowid);
  }

  getRule(ruleId: number): RuleRow | undefined {
    const stmt = this.prepare(
      'SELECT rule_id, contract_id, first_due_date, end_date, frequency FROM rules WHERE rule_id = ?',
    );
    const row = stmt.get(ruleId) as
      | { rule_id: number; contract_id: string; first_due_date: string; end_date: string; frequency: Frequency }
      | undefined;
    if (!row) return undefined;
    return {
      ruleId: row.rule_id,
      contractId: row.contract_id,
      firstDueDate: row.first_due_date,
      endDate: row.end_date,
      frequency: row.frequency,
    };
  }

  upsertResult(ruleId: number, dueDate: string, status: ResultStatus, completedDate: string | null): void {
    const stmt = this.prepare(
      `INSERT INTO results (rule_id, due_date, status, completed_date) VALUES (?, ?, ?, ?)
       ON CONFLICT (rule_id, due_date)
       DO UPDATE SET status = excluded.status, completed_date = excluded.completed_date`,
    );
    stmt.run(ruleId, dueDate, status, completedDate);
  }

  deleteResult(ruleId: number, dueDate: string): void {
    const stmt = this.prepare('DELETE FROM results WHERE rule_id = ? AND due_date = ?');
    stmt.run(ruleId, dueDate);
  }

  /** 逐行吐出全部规则及其在 [rangeStart, rangeEnd] 内的结果聚合（流式，避免大 Map 常驻）。 */
  *iterateRuleAggregates(rangeStart: string, rangeEnd: string): Generator<RuleRow & ResultAggregate> {
    const stmt = this.prepare(
      `SELECT r.rule_id, r.contract_id, r.first_due_date, r.end_date, r.frequency,
              COALESCE(x.exempted, 0) AS exempted,
              COALESCE(x.on_time, 0) AS on_time
       FROM rules r
       LEFT JOIN (
         SELECT rule_id,
                SUM(CASE WHEN status = 'exempted' THEN 1 ELSE 0 END) AS exempted,
                SUM(CASE WHEN status = 'completed' AND completed_date <= due_date THEN 1 ELSE 0 END) AS on_time
         FROM results
         WHERE due_date >= ? AND due_date <= ?
         GROUP BY rule_id
       ) x ON x.rule_id = r.rule_id`,
    );
    for (const row of stmt.iterate(rangeStart, rangeEnd)) {
      const r = row as {
        rule_id: number;
        contract_id: string;
        first_due_date: string;
        end_date: string;
        frequency: Frequency;
        exempted: number;
        on_time: number;
      };
      yield {
        ruleId: r.rule_id,
        contractId: r.contract_id,
        firstDueDate: r.first_due_date,
        endDate: r.end_date,
        frequency: r.frequency,
        exempted: Number(r.exempted),
        onTime: Number(r.on_time),
      };
    }
  }

  close(): void {
    this.db.close();
  }
}
