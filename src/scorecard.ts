import { DatabaseSync, StatementSync } from 'node:sqlite';
import { countPeriodsInRange, normalizeDate } from './dates';
import { ContractSummary, Frequency, PeriodOutcome, RuleInput, UtcDate } from './types';

interface RuleRow {
  id: number;
  contract_id: string;
  first_due_date: string;
  end_date: string;
  frequency: Frequency;
}

/** 合同履约计分库主入口，由上层系统直接调用 */
export class Scorecard {
  private readonly db: DatabaseSync;
  private stmtInsertRule?: StatementSync;
  private stmtUpsertCompleted?: StatementSync;
  private stmtUpsertWaived?: StatementSync;
  private stmtDeleteOutcome?: StatementSync;
  private stmtGetRule?: StatementSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** 登记履约规则，返回规则 id。登记后不可修改。 */
  registerRule(rule: RuleInput): number {
    const firstDue = normalizeDate(rule.firstDueDate);
    const end = normalizeDate(rule.endDate);
    if (!rule.contractId) throw new Error('contractId is required');
    this.stmtInsertRule ??= this.db.prepare(
      'INSERT INTO rules (contract_id, first_due_date, end_date, frequency) VALUES (?, ?, ?, ?)'
    );
    const result = this.stmtInsertRule.run(rule.contractId, firstDue, end, rule.frequency);
    return Number(result.lastInsertRowid);
  }

  /** 登记某一期的处理结果（完成或免除）；重复登记替换旧结果。 */
  recordOutcome(ruleId: number, dueDate: UtcDate, outcome: PeriodOutcome): void {
    const due = normalizeDate(dueDate);
    const rule = this.getRule(ruleId);
    this.assertPeriodExists(rule, due);
    if (outcome.kind === 'completed') {
      const completed = normalizeDate(outcome.completedDate);
      this.stmtUpsertCompleted ??= this.db.prepare(
        `INSERT INTO outcomes (rule_id, due_date, status, completed_date) VALUES (?, ?, 'completed', ?)
         ON CONFLICT (rule_id, due_date) DO UPDATE SET status = 'completed', completed_date = excluded.completed_date`
      );
      this.stmtUpsertCompleted.run(ruleId, due, completed);
    } else {
      this.stmtUpsertWaived ??= this.db.prepare(
        `INSERT INTO outcomes (rule_id, due_date, status, completed_date) VALUES (?, ?, 'waived', NULL)
         ON CONFLICT (rule_id, due_date) DO UPDATE SET status = 'waived', completed_date = NULL`
      );
      this.stmtUpsertWaived.run(ruleId, due);
    }
  }

  /** 撤销某一期的处理结果，恢复为未处理。 */
  revokeOutcome(ruleId: number, dueDate: UtcDate): void {
    const due = normalizeDate(dueDate);
    this.stmtDeleteOutcome ??= this.db.prepare(
      'DELETE FROM outcomes WHERE rule_id = ? AND due_date = ?'
    );
    this.stmtDeleteOutcome.run(ruleId, due);
  }

  /** 查询区间内（含两端，按到期日归属）所有合同的履约汇总。 */
  summarize(rangeStart: UtcDate, rangeEnd: UtcDate): ContractSummary[] {
    const start = normalizeDate(rangeStart);
    const end = normalizeDate(rangeEnd);
    if (start > end) throw new Error(`empty range: ${start}..${end}`);

    const acc = new Map<string, { numerator: number; denominator: number }>();
    const bucket = (contractId: string) => {
      let b = acc.get(contractId);
      if (!b) {
        b = { numerator: 0, denominator: 0 };
        acc.set(contractId, b);
      }
      return b;
    };

    // 流式遍历规则，避免把全部行物化为 JS 对象数组
    for (const rule of this.db
      .prepare('SELECT id, contract_id, first_due_date, end_date, frequency FROM rules')
      .iterate() as Iterable<RuleRow>) {
      const count = countPeriodsInRange(
        rule.first_due_date,
        rule.end_date,
        rule.frequency,
        start,
        end
      );
      if (count > 0) bucket(rule.contract_id).denominator += count;
    }

    // 处理结果在 SQL 内按合同聚合，只回传每合同一行
    const adjustments = this.db
      .prepare(
        `SELECT r.contract_id AS contract_id,
                SUM(CASE WHEN o.status = 'waived' THEN 1 ELSE 0 END) AS waived,
                SUM(CASE WHEN o.status = 'completed' AND o.completed_date <= o.due_date THEN 1 ELSE 0 END) AS on_time
         FROM outcomes o JOIN rules r ON r.id = o.rule_id
         WHERE o.due_date >= ? AND o.due_date <= ?
         GROUP BY r.contract_id`
      )
      .all(start, end) as unknown as { contract_id: string; waived: number; on_time: number }[];
    for (const adj of adjustments) {
      const b = bucket(adj.contract_id);
      b.denominator -= Number(adj.waived);
      b.numerator += Number(adj.on_time);
    }

    const summaries: ContractSummary[] = [];
    for (const [contractId, b] of acc) {
      summaries.push({
        contractId,
        numerator: b.numerator,
        denominator: b.denominator,
        score: computeScore(b.numerator, b.denominator),
        atRisk: b.denominator > 0 && b.numerator * 10 < b.denominator * 7,
      });
    }
    summaries.sort((a, b) => (a.contractId < b.contractId ? -1 : 1));
    return summaries;
  }

  close(): void {
    this.db.close();
  }

  private getRule(ruleId: number): RuleRow {
    this.stmtGetRule ??= this.db.prepare(
      'SELECT id, contract_id, first_due_date, end_date, frequency FROM rules WHERE id = ?'
    );
    const row = this.stmtGetRule.get(ruleId) as unknown as RuleRow | undefined;
    if (!row) throw new Error(`rule not found: ${ruleId}`);
    return row;
  }

  private assertPeriodExists(rule: RuleRow, due: UtcDate): void {
    const count = countPeriodsInRange(rule.first_due_date, rule.end_date, rule.frequency, due, due);
    if (count !== 1) {
      throw new Error(`date ${due} is not a period of rule ${rule.id}`);
    }
  }
}

function computeScore(numerator: number, denominator: number): number {
  if (denominator === 0) return 100;
  return Math.round((numerator / denominator) * 10000) / 100;
}
