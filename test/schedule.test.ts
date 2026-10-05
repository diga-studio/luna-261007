import assert from 'node:assert/strict';
import test from 'node:test';
import { addMonthsClamped } from '../src/dates.js';
import { countDueDates, dueDateAt, isPeriodDueDate } from '../src/schedule.js';

test('月末锚点：1月31日月度期次在2月取月末、3月恢复31日', () => {
  assert.equal(dueDateAt('2024-01-31', 'monthly', 0), '2024-01-31');
  assert.equal(dueDateAt('2024-01-31', 'monthly', 1), '2024-02-29'); // 闰年
  assert.equal(dueDateAt('2024-01-31', 'monthly', 2), '2024-03-31');
  assert.equal(dueDateAt('2025-01-31', 'monthly', 1), '2025-02-28'); // 平年
  assert.equal(dueDateAt('2025-01-31', 'monthly', 2), '2025-03-31');
});

test('闰年锚点：2月29日年度期次平年取2月28日、闰年恢复29日', () => {
  assert.equal(dueDateAt('2024-02-29', 'yearly', 1), '2025-02-28');
  assert.equal(dueDateAt('2024-02-29', 'yearly', 2), '2026-02-28');
  assert.equal(dueDateAt('2024-02-29', 'yearly', 4), '2028-02-29');
});

test('季度锚点：相隔3个月并同样按月末钳制', () => {
  assert.equal(dueDateAt('2024-01-31', 'quarterly', 1), '2024-04-30');
  assert.equal(dueDateAt('2024-01-31', 'quarterly', 2), '2024-07-31');
  assert.equal(dueDateAt('2024-05-31', 'quarterly', 3), '2025-02-28');
});

test('once 只有第 0 期', () => {
  assert.equal(dueDateAt('2024-06-15', 'once', 0), '2024-06-15');
  assert.throws(() => dueDateAt('2024-06-15', 'once', 1));
});

test('addMonthsClamped 保持原始锚点日号', () => {
  assert.equal(addMonthsClamped('2024-01-31', 13), '2025-02-28');
  assert.equal(addMonthsClamped('2024-01-31', 14), '2025-03-31');
});

test('countDueDates 区间两端包含', () => {
  // 月度：2024-01-15 起，终止 2024-12-15，共 12 期
  assert.equal(countDueDates('2024-01-15', '2024-12-15', 'monthly', '2024-01-15', '2024-12-15'), 12);
  // 端点含首期与末期
  assert.equal(countDueDates('2024-01-15', '2024-12-15', 'monthly', '2024-01-15', '2024-01-15'), 1);
  assert.equal(countDueDates('2024-01-15', '2024-12-15', 'monthly', '2024-12-15', '2024-12-15'), 1);
});

test('countDueDates 区间仅截取部分周期', () => {
  // 2024-01-31 起月度，终止 2024-12-31；只取 3~5 月：03-31, 04-30, 05-31
  assert.equal(countDueDates('2024-01-31', '2024-12-31', 'monthly', '2024-03-01', '2024-05-31'), 3);
  // 结束日视为已结束：02-29 到期落在 2 月区间内
  assert.equal(countDueDates('2024-01-31', '2024-12-31', 'monthly', '2024-02-01', '2024-02-29'), 1);
  // 区间在首期之前 / 终止日之后
  assert.equal(countDueDates('2024-01-31', '2024-12-31', 'monthly', '2023-01-01', '2023-12-31'), 0);
  assert.equal(countDueDates('2024-01-31', '2024-12-31', 'monthly', '2025-01-01', '2025-12-31'), 0);
});

test('countDueDates 年度闰年锚点跨多年计数', () => {
  // 2024-02-29 起年度，终止 2028-12-31：2024-02-29, 2025-02-28, 2026-02-28, 2027-02-28, 2028-02-29
  assert.equal(countDueDates('2024-02-29', '2028-12-31', 'yearly', '2024-01-01', '2028-12-31'), 5);
  assert.equal(countDueDates('2024-02-29', '2028-12-31', 'yearly', '2028-01-01', '2028-12-31'), 1);
});

test('isPeriodDueDate 校验期次归属', () => {
  assert.equal(isPeriodDueDate('2024-01-31', '2025-12-31', 'monthly', '2024-02-29'), true);
  assert.equal(isPeriodDueDate('2024-01-31', '2025-12-31', 'monthly', '2024-02-28'), false);
  assert.equal(isPeriodDueDate('2024-01-31', '2024-06-30', 'monthly', '2024-07-31'), false);
  assert.equal(isPeriodDueDate('2024-06-15', '2024-06-15', 'once', '2024-06-15'), true);
  assert.equal(isPeriodDueDate('2024-06-15', '2024-06-15', 'once', '2024-06-16'), false);
});

test('once 规则的期次只按首个到期日归属区间，与终止日无关', () => {
  // endDate 晚于 firstDueDate 时，期次仍只有 firstDueDate 一天
  assert.equal(countDueDates('2024-06-15', '2026-12-31', 'once', '2025-01-01', '2025-12-31'), 0);
  assert.equal(countDueDates('2024-06-15', '2026-12-31', 'once', '2024-06-15', '2024-06-15'), 1);
  assert.equal(countDueDates('2024-06-15', '2026-12-31', 'once', '2024-01-01', '2026-12-31'), 1);
  assert.equal(countDueDates('2024-06-15', '2026-12-31', 'once', '2024-01-01', '2024-06-14'), 0);
});
