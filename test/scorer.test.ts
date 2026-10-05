import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ComplianceScorer } from '../src/index.js';
import { dueDateAt } from '../src/schedule.js';
import type { Frequency, RuleInput } from '../src/types.js';

function makeScorer(t: test.TestContext): ComplianceScorer {
  const dir = mkdtempSync(join(tmpdir(), 'scorer-'));
  return new ComplianceScorer(join(dir, 'test.db'));
}

function only(summary: ReturnType<ComplianceScorer['summarize']>, contractId: string) {
  const row = summary.find((s) => s.contractId === contractId);
  assert.ok(row, `contract ${contractId} missing`);
  return row;
}

test('基本流程：登记规则、登记结果、区间汇总', (t) => {
  const scorer = makeScorer(t);
  const ruleId = scorer.registerRule({
    contractId: 'C1',
    firstDueDate: '2024-01-15',
    endDate: '2024-06-15',
    frequency: 'monthly',
  });
  scorer.recordCompletion(ruleId, '2024-01-15', '2024-01-14'); // 提前完成，按时
  scorer.recordCompletion(ruleId, '2024-02-15', '2024-02-15'); // 当天完成，按时
  scorer.recordCompletion(ruleId, '2024-03-15', '2024-03-20'); // 逾期完成
  // 04、05 期未处理；06 期免除
  scorer.recordExemption(ruleId, '2024-06-15');

  const s = only(scorer.summarize('2024-01-01', '2024-12-31'), 'C1');
  assert.equal(s.numerator, 2);
  assert.equal(s.denominator, 5); // 6 期 - 1 免除
  assert.equal(s.score, 40);
  assert.equal(s.atRisk, true);
  scorer.close();
});

test('区间两端包含，且按到期日归属区间', (t) => {
  const scorer = makeScorer(t);
  const ruleId = scorer.registerRule({
    contractId: 'C1',
    firstDueDate: '2024-01-10',
    endDate: '2024-12-10',
    frequency: 'monthly',
  });
  for (const due of ['2024-01-10', '2024-06-10', '2024-12-10']) {
    scorer.recordCompletion(ruleId, due, due);
  }
  // 端点上的期次被包含
  const s = only(scorer.summarize('2024-01-10', '2024-12-10'), 'C1');
  assert.equal(s.denominator, 12);
  assert.equal(s.numerator, 3);
  // 缩到单月
  const june = only(scorer.summarize('2024-06-01', '2024-06-30'), 'C1');
  assert.equal(june.denominator, 1);
  assert.equal(june.numerator, 1);
  scorer.close();
});

test('未来到期的期次即使提前完成，也不进入此前区间', (t) => {
  const scorer = makeScorer(t);
  const ruleId = scorer.registerRule({
    contractId: 'C1',
    firstDueDate: '2024-01-31',
    endDate: '2024-12-31',
    frequency: 'monthly',
  });
  // 提前完成 2024-06-30 期
  scorer.recordCompletion(ruleId, '2024-06-30', '2024-03-01');
  const q1 = only(scorer.summarize('2024-01-01', '2024-03-31'), 'C1');
  assert.equal(q1.denominator, 3); // 1/31、2/29、3/31
  assert.equal(q1.numerator, 0);
  const h1 = only(scorer.summarize('2024-01-01', '2024-06-30'), 'C1');
  assert.equal(h1.denominator, 6);
  assert.equal(h1.numerator, 1);
  scorer.close();
});

test('同一期从按时完成更正为逾期完成，历史区间立即反映', (t) => {
  const scorer = makeScorer(t);
  const ruleId = scorer.registerRule({
    contractId: 'C1',
    firstDueDate: '2024-01-15',
    endDate: '2024-03-15',
    frequency: 'monthly',
  });
  scorer.recordCompletion(ruleId, '2024-01-15', '2024-01-15');
  let s = only(scorer.summarize('2024-01-01', '2024-03-31'), 'C1');
  assert.equal(s.numerator, 1);
  assert.equal(s.denominator, 3);

  // 更正完成日期为逾期
  scorer.recordCompletion(ruleId, '2024-01-15', '2024-01-20');
  s = only(scorer.summarize('2024-01-01', '2024-03-31'), 'C1');
  assert.equal(s.numerator, 0);
  assert.equal(s.denominator, 3); // 逾期完成仍留在分母
  assert.equal(s.score, 0);
  scorer.close();
});

test('免除后撤销免除，再改为完成；重复登记不增加期次数', (t) => {
  const scorer = makeScorer(t);
  const ruleId = scorer.registerRule({
    contractId: 'C1',
    firstDueDate: '2024-01-15',
    endDate: '2024-02-15',
    frequency: 'monthly',
  });
  scorer.recordExemption(ruleId, '2024-01-15');
  let s = only(scorer.summarize('2024-01-01', '2024-12-31'), 'C1');
  assert.equal(s.denominator, 1); // 2 期 - 1 免除
  assert.equal(s.score, 0);

  // 重复登记免除：分母不变
  scorer.recordExemption(ruleId, '2024-01-15');
  s = only(scorer.summarize('2024-01-01', '2024-12-31'), 'C1');
  assert.equal(s.denominator, 1);

  // 撤销免除 -> 未处理，回到分母
  scorer.revokeResult(ruleId, '2024-01-15');
  s = only(scorer.summarize('2024-01-01', '2024-12-31'), 'C1');
  assert.equal(s.denominator, 2);
  assert.equal(s.numerator, 0);

  // 撤销后登记按时完成
  scorer.recordCompletion(ruleId, '2024-01-15', '2024-01-10');
  s = only(scorer.summarize('2024-01-01', '2024-12-31'), 'C1');
  assert.equal(s.denominator, 2);
  assert.equal(s.numerator, 1);
  assert.equal(s.score, 50);

  // 完成改免除：分子减少、分母也减少
  scorer.recordExemption(ruleId, '2024-01-15');
  s = only(scorer.summarize('2024-01-01', '2024-12-31'), 'C1');
  assert.equal(s.denominator, 1);
  assert.equal(s.numerator, 0);
  assert.equal(s.score, 0);
  scorer.close();
});

test('展示分数舍入到 70 但未舍入比例低于 70%，仍处风险', (t) => {
  const scorer = makeScorer(t);
  // 构造 13999/20000 = 0.69995：展示分四舍五入为 70.00，但未舍入比例 < 0.7。
  // 40 条月度规则 x 600 期 = 24000 期；免除 4000 期 -> 分母 20000；按时完成 13999 期。
  const ruleIds: number[] = [];
  for (let i = 0; i < 40; i++) {
    ruleIds.push(
      scorer.registerRule({
        contractId: 'C1',
        firstDueDate: '2024-01-15',
        endDate: '2073-12-15',
        frequency: 'monthly',
      }),
    );
  }
  let exemptedLeft = 4000;
  let onTimeLeft = 13999;
  scorer.transaction(() => {
    for (const id of ruleIds) {
      for (let n = 0; n < 600; n++) {
        const due = dueDateAt('2024-01-15', 'monthly', n);
        if (exemptedLeft > 0) {
          scorer.recordExemption(id, due);
          exemptedLeft--;
        } else if (onTimeLeft > 0) {
          scorer.recordCompletion(id, due, due);
          onTimeLeft--;
        }
      }
    }
  });
  const s = only(scorer.summarize('2024-01-01', '2073-12-31'), 'C1');
  assert.equal(s.numerator, 13999);
  assert.equal(s.denominator, 20000);
  assert.equal(s.score, 70); // 展示分已舍入到 70.00
  assert.equal(s.atRisk, true); // 但未舍入比例 0.69995 < 0.7

  // 再补 1 期（此前未处理的一期）按时完成 -> 14000/20000 = 0.7，不再风险
  scorer.recordCompletion(ruleIds[39]!, dueDateAt('2024-01-15', 'monthly', 599), '2024-01-15');
  const s2 = only(scorer.summarize('2024-01-01', '2073-12-31'), 'C1');
  assert.equal(s2.score, 70);
  assert.equal(s2.atRisk, false);
  scorer.close();
});

test('分母为 0 时记 100 分且无风险', (t) => {
  const scorer = makeScorer(t);
  const ruleId = scorer.registerRule({
    contractId: 'C1',
    firstDueDate: '2024-01-15',
    endDate: '2024-03-15',
    frequency: 'monthly',
  });
  scorer.recordExemption(ruleId, '2024-01-15');
  scorer.recordExemption(ruleId, '2024-02-15');
  scorer.recordExemption(ruleId, '2024-03-15');
  const s = only(scorer.summarize('2024-01-01', '2024-12-31'), 'C1');
  assert.equal(s.denominator, 0);
  assert.equal(s.score, 100);
  assert.equal(s.atRisk, false);
  scorer.close();
});

test('非法输入校验', (t) => {
  const scorer = makeScorer(t);
  assert.throws(() =>
    scorer.registerRule({
      contractId: 'C1',
      firstDueDate: '2024-02-30',
      endDate: '2024-12-31',
      frequency: 'monthly',
    }),
  );
  assert.throws(() =>
    scorer.registerRule({
      contractId: 'C1',
      firstDueDate: '2024-06-01',
      endDate: '2024-01-01',
      frequency: 'monthly',
    }),
  );
  const ruleId = scorer.registerRule({
    contractId: 'C1',
    firstDueDate: '2024-01-31',
    endDate: '2024-12-31',
    frequency: 'monthly',
  });
  // 不是该规则的期次
  assert.throws(() => scorer.recordCompletion(ruleId, '2024-02-28', '2024-02-28'));
  assert.throws(() => scorer.recordExemption(ruleId, '2025-01-31'));
  assert.throws(() => scorer.recordCompletion(9999, '2024-01-31', '2024-01-31'));
  assert.throws(() => scorer.summarize('2024-12-31', '2024-01-01'));
  scorer.close();
});

test('小规模汇总与逐期独立核算完全一致（含月末/闰年锚点）', (t) => {
  const scorer = makeScorer(t);
  const rules: Array<{ id: number; input: RuleInput }> = [];
  const inputs: RuleInput[] = [
    { contractId: 'A', firstDueDate: '2024-01-31', endDate: '2025-12-31', frequency: 'monthly' },
    { contractId: 'A', firstDueDate: '2024-02-29', endDate: '2032-02-29', frequency: 'yearly' },
    { contractId: 'A', firstDueDate: '2024-01-31', endDate: '2025-06-30', frequency: 'quarterly' },
    { contractId: 'B', firstDueDate: '2024-03-15', endDate: '2024-03-15', frequency: 'once' },
    { contractId: 'B', firstDueDate: '2023-12-31', endDate: '2025-12-31', frequency: 'monthly' },
  ];
  for (const input of inputs) {
    rules.push({ id: scorer.registerRule(input), input });
  }
  // 伪随机但确定性地登记处理结果
  const results = new Map<string, { status: 'completed' | 'exempted'; completedDate: string | null }>();
  let seed = 42;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (const { id, input } of rules) {
    for (let n = 0; ; n++) {
      if (input.frequency === 'once' && n > 0) break;
      const due = dueDateAt(input.firstDueDate, input.frequency, n);
      if (due > input.endDate) break;
      const r = rand();
      if (r < 0.5) {
        // 完成：一半按时一半逾期
        const completed = r < 0.25 ? due : addDays(due, 3);
        scorer.recordCompletion(id, due, completed);
        results.set(`${id}|${due}`, { status: 'completed', completedDate: completed });
      } else if (r < 0.65) {
        scorer.recordExemption(id, due);
        results.set(`${id}|${due}`, { status: 'exempted', completedDate: null });
      }
    }
  }

  // 暴力逐期核算
  const brute = (start: string, end: string) => {
    const acc = new Map<string, { num: number; den: number }>();
    for (const { id, input } of rules) {
      for (let n = 0; ; n++) {
        if (input.frequency === 'once' && n > 0) break;
        const due = dueDateAt(input.firstDueDate, input.frequency, n);
        if (due > input.endDate || due > end) break;
        if (due < start) continue;
        const cur = acc.get(input.contractId) ?? { num: 0, den: 0 };
        const res = results.get(`${id}|${due}`);
        if (res?.status !== 'exempted') cur.den += 1;
        if (res?.status === 'completed' && res.completedDate !== null && res.completedDate <= due) {
          cur.num += 1;
        }
        acc.set(input.contractId, cur);
      }
    }
    return acc;
  };

  for (const [start, end] of [
    ['2024-01-01', '2024-12-31'],
    ['2024-02-01', '2024-03-31'], // 截取部分周期
    ['2024-02-29', '2024-02-29'], // 单日
    ['2023-01-01', '2033-12-31'], // 全跨度
    ['2025-02-01', '2025-02-28'], // 平年二月
  ] as const) {
    const expected = brute(start, end);
    const actual = scorer.summarize(start, end);
    for (const row of actual) {
      const e = expected.get(row.contractId) ?? { num: 0, den: 0 };
      assert.equal(row.numerator, e.num, `${row.contractId} numerator [${start}, ${end}]`);
      assert.equal(row.denominator, e.den, `${row.contractId} denominator [${start}, ${end}]`);
      const expectedScore =
        e.den === 0 ? 100 : Math.floor((2 * e.num * 10000 + e.den) / (2 * e.den)) / 100;
      assert.equal(row.score, expectedScore, `${row.contractId} score [${start}, ${end}]`);
      assert.equal(row.atRisk, e.den > 0 && e.num * 10 < e.den * 7);
    }
  }
  scorer.close();
});

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
