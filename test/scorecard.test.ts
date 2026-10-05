import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db';
import { Scorecard } from '../src/scorecard';
import { enumeratePeriods } from '../src/dates';
import { ContractSummary, Frequency, PeriodOutcome, UtcDate } from '../src/types';

function makeScorecard(): Scorecard {
  return new Scorecard(openDatabase(':memory:'));
}

function summaryOf(summaries: ContractSummary[], contractId: string): ContractSummary {
  const s = summaries.find((x) => x.contractId === contractId);
  assert.ok(s, `missing summary for ${contractId}`);
  return s;
}

test('基本汇总：按时完成计入分子，未处理留在分母', () => {
  const sc = makeScorecard();
  const r = sc.registerRule({
    contractId: 'C1',
    firstDueDate: '2024-01-15',
    endDate: '2024-12-31',
    frequency: 'monthly',
  });
  sc.recordOutcome(r, '2024-01-15', { kind: 'completed', completedDate: '2024-01-10' });
  sc.recordOutcome(r, '2024-02-15', { kind: 'completed', completedDate: '2024-02-20' }); // 逾期
  const [s] = sc.summarize('2024-01-01', '2024-03-31');
  assert.equal(s.numerator, 1);
  assert.equal(s.denominator, 3);
  assert.equal(s.score, 33.33);
  assert.equal(s.atRisk, true);
  sc.close();
});

test('同一期重复登记替换旧结果：按时改为逾期', () => {
  const sc = makeScorecard();
  const r = sc.registerRule({
    contractId: 'C1',
    firstDueDate: '2024-01-15',
    endDate: '2024-03-31',
    frequency: 'monthly',
  });
  sc.recordOutcome(r, '2024-01-15', { kind: 'completed', completedDate: '2024-01-15' });
  let s = summaryOf(sc.summarize('2024-01-01', '2024-01-31'), 'C1');
  assert.equal(s.numerator, 1);
  assert.equal(s.denominator, 1);
  assert.equal(s.score, 100);

  // 更正为逾期完成：分子减少，分母不变
  sc.recordOutcome(r, '2024-01-15', { kind: 'completed', completedDate: '2024-01-16' });
  s = summaryOf(sc.summarize('2024-01-01', '2024-01-31'), 'C1');
  assert.equal(s.numerator, 0);
  assert.equal(s.denominator, 1);
  assert.equal(s.score, 0);
  assert.equal(s.atRisk, true);
  sc.close();
});

test('免除后撤销：分母先扣后恢复，历史区间立即更新', () => {
  const sc = makeScorecard();
  const r = sc.registerRule({
    contractId: 'C1',
    firstDueDate: '2024-01-15',
    endDate: '2024-03-31',
    frequency: 'monthly',
  });
  sc.recordOutcome(r, '2024-01-15', { kind: 'waived' });
  let s = summaryOf(sc.summarize('2024-01-01', '2024-01-31'), 'C1');
  assert.equal(s.denominator, 0);
  assert.equal(s.score, 100);
  assert.equal(s.atRisk, false);

  // 撤销免除，恢复为未处理：回到分母
  sc.revokeOutcome(r, '2024-01-15');
  s = summaryOf(sc.summarize('2024-01-01', '2024-01-31'), 'C1');
  assert.equal(s.numerator, 0);
  assert.equal(s.denominator, 1);
  assert.equal(s.score, 0);
  assert.equal(s.atRisk, true);

  // 免除再改为按时完成
  sc.recordOutcome(r, '2024-02-15', { kind: 'waived' });
  sc.recordOutcome(r, '2024-02-15', { kind: 'completed', completedDate: '2024-02-15' });
  s = summaryOf(sc.summarize('2024-02-01', '2024-02-29'), 'C1');
  assert.equal(s.numerator, 1);
  assert.equal(s.denominator, 1);
  sc.close();
});

test('提前完成允许；未来期次提前完成不进入此前区间', () => {
  const sc = makeScorecard();
  const r = sc.registerRule({
    contractId: 'C1',
    firstDueDate: '2024-06-15',
    endDate: '2024-12-31',
    frequency: 'monthly',
  });
  sc.recordOutcome(r, '2024-06-15', { kind: 'completed', completedDate: '2024-01-05' });
  const before = sc.summarize('2024-01-01', '2024-05-31');
  assert.equal(before.length, 0); // 区间内无到期期次
  const s = summaryOf(sc.summarize('2024-06-01', '2024-06-30'), 'C1');
  assert.equal(s.numerator, 1);
  assert.equal(s.denominator, 1);
  sc.close();
});

test('区间两端均包含，按到期日归属', () => {
  const sc = makeScorecard();
  const r = sc.registerRule({
    contractId: 'C1',
    firstDueDate: '2024-01-31',
    endDate: '2024-04-30',
    frequency: 'monthly',
  });
  sc.recordOutcome(r, '2024-01-31', { kind: 'completed', completedDate: '2024-01-31' });
  sc.recordOutcome(r, '2024-04-30', { kind: 'completed', completedDate: '2024-04-30' });
  const s = summaryOf(sc.summarize('2024-01-31', '2024-04-30'), 'C1');
  assert.equal(s.numerator, 2);
  assert.equal(s.denominator, 4);
  sc.close();
});

test('分数舍入到 70 但未舍入比例低于 70 仍为风险', () => {
  const sc = makeScorecard();
  // 25000 期，按时 17499 期：比例 0.69996 -> 显示 70.00，实际 < 0.7
  // 用 once 规则凑足 25000 期
  const ruleIds: number[] = [];
  for (let i = 0; i < 25000; i++) {
    ruleIds.push(
      sc.registerRule({
        contractId: 'C1',
        firstDueDate: '2024-06-15',
        endDate: '2024-06-15',
        frequency: 'once',
      })
    );
  }
  for (let i = 0; i < 17499; i++) {
    sc.recordOutcome(ruleIds[i], '2024-06-15', {
      kind: 'completed',
      completedDate: '2024-06-15',
    });
  }
  const s = summaryOf(sc.summarize('2024-01-01', '2024-12-31'), 'C1');
  assert.equal(s.numerator, 17499);
  assert.equal(s.denominator, 25000);
  assert.equal(s.score, 70);
  assert.equal(s.atRisk, true);
  sc.close();
});

test('恰好 70% 不是风险', () => {
  const sc = makeScorecard();
  const ids: number[] = [];
  for (let i = 0; i < 10; i++) {
    ids.push(
      sc.registerRule({
        contractId: 'C1',
        firstDueDate: '2024-06-15',
        endDate: '2024-06-15',
        frequency: 'once',
      })
    );
  }
  for (let i = 0; i < 7; i++) {
    sc.recordOutcome(ids[i], '2024-06-15', { kind: 'completed', completedDate: '2024-06-15' });
  }
  const s = summaryOf(sc.summarize('2024-01-01', '2024-12-31'), 'C1');
  assert.equal(s.score, 70);
  assert.equal(s.atRisk, false);
  sc.close();
});

test('小规模汇总与逐期独立核算完全一致', () => {
  const sc = makeScorecard();
  interface Rec {
    ruleId: number;
    contractId: string;
    firstDue: UtcDate;
    end: UtcDate;
    freq: Frequency;
  }
  const recs: Rec[] = [];
  const freqs: Frequency[] = ['once', 'monthly', 'quarterly', 'yearly'];
  let seed = 7;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let i = 0; i < 30; i++) {
    const contractId = `C${1 + Math.floor(rand() * 5)}`;
    const y = 2024 + Math.floor(rand() * 3);
    const m = 1 + Math.floor(rand() * 12);
    const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const d = 1 + Math.floor(rand() * dim);
    const firstDue = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const end = `${y + 2}-12-31`;
    const freq = freqs[Math.floor(rand() * freqs.length)];
    const ruleId = sc.registerRule({ contractId, firstDueDate: firstDue, endDate: end, frequency: freq });
    recs.push({ ruleId, contractId, firstDue, end, freq });
  }
  // 随机登记处理结果（含覆盖与撤销）
  const outcomes = new Map<string, PeriodOutcome>();
  for (const rec of recs) {
    for (const due of enumeratePeriods(rec.firstDue, rec.end, rec.freq)) {
      const roll = rand();
      if (roll < 0.3) {
        const completedDate = rand() < 0.5 ? due : '2029-01-01';
        const outcome: PeriodOutcome = { kind: 'completed', completedDate };
        sc.recordOutcome(rec.ruleId, due, outcome);
        outcomes.set(`${rec.ruleId}|${due}`, outcome);
      } else if (roll < 0.4) {
        sc.recordOutcome(rec.ruleId, due, { kind: 'waived' });
        outcomes.set(`${rec.ruleId}|${due}`, { kind: 'waived' });
        if (rand() < 0.5) {
          sc.revokeOutcome(rec.ruleId, due);
          outcomes.delete(`${rec.ruleId}|${due}`);
        }
      }
    }
  }
  // 独立逐期核算
  const rangeStart = '2025-01-01';
  const rangeEnd = '2025-12-31';
  const expected = new Map<string, { num: number; den: number }>();
  for (const rec of recs) {
    for (const due of enumeratePeriods(rec.firstDue, rec.end, rec.freq)) {
      if (due < rangeStart || due > rangeEnd) continue;
      let b = expected.get(rec.contractId);
      if (!b) {
        b = { num: 0, den: 0 };
        expected.set(rec.contractId, b);
      }
      const o = outcomes.get(`${rec.ruleId}|${due}`);
      if (o && o.kind === 'waived') continue;
      b.den += 1;
      if (o && o.kind === 'completed' && o.completedDate <= due) b.num += 1;
    }
  }
  const summaries = sc.summarize(rangeStart, rangeEnd);
  assert.equal(summaries.length, expected.size);
  for (const s of summaries) {
    const e = expected.get(s.contractId)!;
    assert.equal(s.numerator, e.num, `${s.contractId} numerator`);
    assert.equal(s.denominator, e.den, `${s.contractId} denominator`);
    const expectedScore = e.den === 0 ? 100 : Math.round((e.num / e.den) * 10000) / 100;
    assert.equal(s.score, expectedScore, `${s.contractId} score`);
    assert.equal(s.atRisk, e.den > 0 && e.num * 10 < e.den * 7, `${s.contractId} atRisk`);
  }
  sc.close();
});

test('非法期次与未知规则报错', () => {
  const sc = makeScorecard();
  const r = sc.registerRule({
    contractId: 'C1',
    firstDueDate: '2024-01-15',
    endDate: '2024-12-31',
    frequency: 'monthly',
  });
  assert.throws(() => sc.recordOutcome(r, '2024-01-16', { kind: 'waived' }));
  assert.throws(() =>
    sc.recordOutcome(9999, '2024-01-15', { kind: 'completed', completedDate: '2024-01-15' })
  );
  sc.close();
});
