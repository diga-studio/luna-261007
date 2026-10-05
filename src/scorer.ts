import { assertValidDate } from './dates.js';
import { countDueDates, isPeriodDueDate } from './schedule.js';
import { Store, type RuleRow } from './store.js';
import type { ContractSummary, Frequency, RuleInput } from './types.js';

const FREQUENCIES: readonly Frequency[] = ['once', 'monthly', 'quarterly', 'yearly'];

/** 四舍五入保留两位小数（整数运算，避免浮点边界误差）。 */
function scoreOf(numerator: number, denominator: number): number {
  if (denominator === 0) return 100;
  const scaled = Math.floor((2 * numerator * 10000 + denominator) / (2 * denominator));
  return scaled / 100;
}

/** 合同履约计分库主入口，由上层系统直接调用。 */
export class ComplianceScorer {
  private readonly store: Store;

  constructor(dbPath: string) {
    this.store = new Store(dbPath);
  }

  /** 登记履约规则，返回规则 ID。规则登记后不可修改。 */
  registerRule(rule: RuleInput): number {
    if (!rule.contractId) throw new Error('contractId must be non-empty');
    if (!FREQUENCIES.includes(rule.frequency)) {
      throw new Error(`invalid frequency: ${rule.frequency}`);
    }
    assertValidDate(rule.firstDueDate, 'firstDueDate');
    assertValidDate(rule.endDate, 'endDate');
    if (rule.firstDueDate > rule.endDate) {
      throw new RangeError(`firstDueDate ${rule.firstDueDate} is after endDate ${rule.endDate}`);
    }
    return this.store.insertRule({
      contractId: rule.contractId,
      firstDueDate: rule.firstDueDate,
      endDate: rule.endDate,
      frequency: rule.frequency,
    });
  }

  /** 登记某一期完成；重复登记替换旧结果。提前完成允许。 */
  recordCompletion(ruleId: number, dueDate: string, completedDate: string): void {
    const rule = this.requireRule(ruleId);
    assertValidDate(completedDate, 'completedDate');
    this.assertPeriod(rule, dueDate);
    this.store.upsertResult(ruleId, dueDate, 'completed', completedDate);
  }

  /** 登记某一期免除；重复登记替换旧结果。 */
  recordExemption(ruleId: number, dueDate: string): void {
    const rule = this.requireRule(ruleId);
    this.assertPeriod(rule, dueDate);
    this.store.upsertResult(ruleId, dueDate, 'exempted', null);
  }

  /** 撤销某一期的处理结果，恢复为未处理。 */
  revokeResult(ruleId: number, dueDate: string): void {
    const rule = this.requireRule(ruleId);
    this.assertPeriod(rule, dueDate);
    this.store.deleteResult(ruleId, dueDate);
  }

  /** 查询 [startDate, endDate]（含两端）内所有合同的履约汇总。 */
  summarize(startDate: string, endDate: string): ContractSummary[] {
    assertValidDate(startDate, 'startDate');
    assertValidDate(endDate, 'endDate');
    if (startDate > endDate) {
      throw new RangeError(`startDate ${startDate} is after endDate ${endDate}`);
    }
    const byContract = new Map<string, { numerator: number; denominator: number }>();
    for (const rule of this.store.iterateRuleAggregates(startDate, endDate)) {
      const total = countDueDates(rule.firstDueDate, rule.endDate, rule.frequency, startDate, endDate);
      const denominator = total - rule.exempted;
      let acc = byContract.get(rule.contractId);
      if (!acc) {
        acc = { numerator: 0, denominator: 0 };
        byContract.set(rule.contractId, acc);
      }
      acc.numerator += rule.onTime;
      acc.denominator += denominator;
    }
    const summaries: ContractSummary[] = [];
    for (const [contractId, acc] of byContract) {
      summaries.push({
        contractId,
        numerator: acc.numerator,
        denominator: acc.denominator,
        score: scoreOf(acc.numerator, acc.denominator),
        atRisk: acc.denominator > 0 && acc.numerator * 10 < acc.denominator * 7,
      });
    }
    summaries.sort((a, b) => (a.contractId < b.contractId ? -1 : a.contractId > b.contractId ? 1 : 0));
    return summaries;
  }

  close(): void {
    this.store.close();
  }

  /** 在单个事务中执行批量登记（如批量导入），任一失败整体回滚。 */
  transaction<T>(fn: () => T): T {
    return this.store.transaction(fn);
  }

  private requireRule(ruleId: number): RuleRow {
    const rule = this.store.getRule(ruleId);
    if (!rule) throw new Error(`unknown ruleId: ${ruleId}`);
    return rule;
  }

  private assertPeriod(rule: RuleRow, dueDate: string): void {
    assertValidDate(dueDate, 'dueDate');
    if (!isPeriodDueDate(rule.firstDueDate, rule.endDate, rule.frequency, dueDate)) {
      throw new RangeError(`${dueDate} is not a period of rule ${rule.ruleId}`);
    }
  }
}
