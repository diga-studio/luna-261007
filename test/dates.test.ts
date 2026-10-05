import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countPeriodsInRange, enumeratePeriods, periodDueDate } from '../src/dates';

test('月末锚点：1月31日月度期次在2月取月末，3月恢复31日', () => {
  assert.equal(periodDueDate('2024-01-31', 'monthly', 1), '2024-02-29');
  assert.equal(periodDueDate('2024-01-31', 'monthly', 2), '2024-03-31');
  assert.equal(periodDueDate('2024-01-31', 'monthly', 3), '2024-04-30');
  assert.equal(periodDueDate('2024-01-31', 'monthly', 4), '2024-05-31');
});

test('闰年锚点：2月29日年度期次平年取2月28日，闰年恢复29日', () => {
  assert.equal(periodDueDate('2024-02-29', 'yearly', 1), '2025-02-28');
  assert.equal(periodDueDate('2024-02-29', 'yearly', 2), '2026-02-28');
  assert.equal(periodDueDate('2024-02-29', 'yearly', 4), '2028-02-29');
});

test('季度锚点：相隔3个月且日号clamp后恢复', () => {
  assert.equal(periodDueDate('2024-01-31', 'quarterly', 1), '2024-04-30');
  assert.equal(periodDueDate('2024-01-31', 'quarterly', 2), '2024-07-31');
  assert.equal(periodDueDate('2024-05-31', 'quarterly', 1), '2024-08-31');
  assert.equal(periodDueDate('2024-05-31', 'quarterly', 3), '2025-02-28');
});

test('once 频率只有一期', () => {
  assert.equal(periodDueDate('2024-06-15', 'once', 0), '2024-06-15');
  assert.throws(() => periodDueDate('2024-06-15', 'once', 1));
});

test('枚举期次：首期包含，终止日之后不产生', () => {
  assert.deepEqual(enumeratePeriods('2024-01-31', '2024-04-30', 'monthly'), [
    '2024-01-31',
    '2024-02-29',
    '2024-03-31',
    '2024-04-30',
  ]);
  assert.deepEqual(enumeratePeriods('2024-01-31', '2024-04-29', 'monthly'), [
    '2024-01-31',
    '2024-02-29',
    '2024-03-31',
  ]);
  assert.deepEqual(enumeratePeriods('2024-06-15', '2024-06-14', 'monthly'), []);
});

test('区间计数与逐期枚举一致（含部分截取周期、月末锚点）', () => {
  const cases: Array<[string, string, 'once' | 'monthly' | 'quarterly' | 'yearly']> = [
    ['2024-01-31', '2026-12-31', 'monthly'],
    ['2024-02-29', '2030-12-31', 'yearly'],
    ['2023-05-31', '2025-11-30', 'quarterly'],
    ['2024-06-15', '2024-06-15', 'once'],
  ];
  const ranges: Array<[string, string]> = [
    ['2024-01-01', '2024-12-31'],
    ['2024-02-01', '2024-02-29'],
    ['2024-03-01', '2024-03-30'],
    ['2025-06-15', '2026-02-28'],
    ['2024-01-31', '2024-01-31'],
  ];
  for (const [firstDue, end, freq] of cases) {
    const all = enumeratePeriods(firstDue, end, freq);
    for (const [s, e] of ranges) {
      const expected = all.filter((d) => d >= s && d <= e).length;
      assert.equal(
        countPeriodsInRange(firstDue, end, freq, s, e),
        expected,
        `${freq} ${firstDue}..${end} in [${s}, ${e}]`
      );
    }
  }
});

test('随机抽样：计数与枚举一致（50年跨度）', () => {
  let seed = 42;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const freqs = ['monthly', 'quarterly', 'yearly'] as const;
  for (let i = 0; i < 200; i++) {
    const y = 2024 + Math.floor(rand() * 40);
    const m = 1 + Math.floor(rand() * 12);
    const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const day = 1 + Math.floor(rand() * dim);
    const firstDue = `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const freq = freqs[Math.floor(rand() * 3)];
    const end = `${Math.min(y + 1 + Math.floor(rand() * 10), 2074)}-12-31`;
    const all = enumeratePeriods(firstDue, end, freq);
    const sy = 2024 + Math.floor(rand() * 45);
    const s = `${sy}-01-01`;
    const e = `${sy + Math.floor(rand() * 5)}-06-30`;
    const expected = all.filter((dd) => dd >= s && dd <= e).length;
    assert.equal(countPeriodsInRange(firstDue, end, freq, s, e), expected, `${freq} ${firstDue}`);
  }
});
