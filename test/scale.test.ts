import assert from 'node:assert/strict';
import { mkdtempSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ComplianceScorer } from '../src/index.js';
import { dueDateAt } from '../src/schedule.js';
import type { Frequency } from '../src/types.js';

const CONTRACTS = 10_000;
const RULES = 100_000;
const RESULTS = 200_000;
const MIB = 1024 * 1024;

// 确定性伪随机，保证用例可复现
function makeRand(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

const FREQUENCIES: Frequency[] = ['once', 'monthly', 'quarterly', 'yearly'];

const gc: () => void = typeof global.gc === 'function' ? global.gc : () => {};

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

test('规模：1万合同/10万规则/20万结果/50年跨度', { timeout: 600_000 }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'scale-'));
  const dbPath = join(dir, 'scale.db');

  // 基线：空库进程的常驻内存
  const baseline = new ComplianceScorer(join(dir, 'empty.db'));
  gc();
  const baseRss = process.memoryUsage().rss;
  baseline.close();

  const scorer = new ComplianceScorer(dbPath);

  // ---- 数据装载（临时对象不带出作用域，避免污染查询阶段的内存测量） ----
  const { insertMs, target } = (() => {
    const rand = makeRand(20240101);
    const ruleMeta: Array<{ id: number; first: string; end: string; freq: Frequency }> = [];
    const t0 = performance.now();
    // 10 万条规则：每合同 10 条，首个到期日分布于 50 年跨度内
    scorer.transaction(() => {
      for (let i = 0; i < RULES; i++) {
        const contractId = `CT-${i % CONTRACTS}`;
        const freq = FREQUENCIES[i % 4]!; // once/monthly/quarterly/yearly 各 1/4
        const startYear = 2024 + Math.floor(rand() * 40); // 2024..2063
        const startMonth = 1 + Math.floor(rand() * 12);
        const startDay = 1 + Math.floor(rand() * 28);
        const first = `${startYear}-${String(startMonth).padStart(2, '0')}-${String(startDay).padStart(2, '0')}`;
        const spanYears = freq === 'once' ? 0 : 1 + Math.floor(rand() * Math.min(10, 2074 - startYear));
        const end = freq === 'once' ? first : `${startYear + spanYears}-12-31`;
        const id = scorer.registerRule({ contractId, firstDueDate: first, endDate: end, frequency: freq });
        ruleMeta.push({ id, first, end, freq });
      }
    });
    // 20 万条处理结果
    scorer.transaction(() => {
      for (let i = 0; i < RESULTS; i++) {
        const rule = ruleMeta[Math.floor(rand() * ruleMeta.length)]!;
        const n = Math.floor(rand() * 24); // 前若干期
        let due: string;
        try {
          due = dueDateAt(rule.first, rule.freq, n);
        } catch {
          continue; // once 规则只有第 0 期
        }
        if (due > rule.end) continue;
        if (rand() < 0.15) {
          scorer.recordExemption(rule.id, due);
        } else {
          // 80% 按时（含提前），20% 逾期
          const completed =
            rand() < 0.8 ? addDays(due, -Math.floor(rand() * 5)) : addDays(due, 1 + Math.floor(rand() * 10));
          scorer.recordCompletion(rule.id, due, completed);
        }
      }
    });
    const target = ruleMeta.find((r) => r.freq !== 'once')!;
    return { insertMs: performance.now() - t0, target };
  })();

  // ---- 预热后查询：全跨度 + 任意子区间 ----
  const full = scorer.summarize('2024-01-01', '2074-12-31'); // 预热
  assert.equal(full.length, CONTRACTS);
  gc();
  const loadedRss = process.memoryUsage().rss;

  const t1 = performance.now();
  const fullAgain = scorer.summarize('2024-01-01', '2074-12-31');
  const fullQueryMs = performance.now() - t1;

  const t2 = performance.now();
  const windowed = scorer.summarize('2030-06-01', '2035-05-31');
  const windowQueryMs = performance.now() - t2;

  assert.ok(fullQueryMs < 2000, `全跨度查询 ${fullQueryMs.toFixed(0)}ms 超过 2s`);
  assert.ok(windowQueryMs < 2000, `子区间查询 ${windowQueryMs.toFixed(0)}ms 超过 2s`);
  assert.ok(windowed.length > 0);

  // ---- 更正处理结果后，相同区间立即得到新结果 ----
  const targetDue = dueDateAt(target.first, target.freq, 0);
  const before = scorer.summarize('2024-01-01', '2074-12-31');
  const contractBefore = before.find((s) => s.contractId === `CT-${(target.id - 1) % CONTRACTS}`)!;
  scorer.recordCompletion(target.id, targetDue, targetDue); // 登记为按时完成
  const after = scorer.summarize('2024-01-01', '2074-12-31');
  const contractAfter = after.find((s) => s.contractId === contractBefore.contractId)!;
  const expectedDelta = 1; // 该期此前可能是未处理/逾期/免除
  assert.ok(
    contractAfter.numerator === contractBefore.numerator + expectedDelta ||
      (contractAfter.numerator === contractBefore.numerator &&
        contractAfter.denominator === contractBefore.denominator - 1),
    `更正后汇总未变化: before=${JSON.stringify(contractBefore)} after=${JSON.stringify(contractAfter)}`,
  );
  // 撤销后恢复
  scorer.revokeResult(target.id, targetDue);
  const reverted = scorer.summarize('2024-01-01', '2074-12-31');
  const contractReverted = reverted.find((s) => s.contractId === contractBefore.contractId)!;
  assert.deepEqual(
    { num: contractReverted.numerator, den: contractReverted.denominator },
    { num: contractBefore.numerator, den: contractBefore.denominator },
  );

  // ---- 内存增量：相对空库进程 ----
  gc();
  const peakRss = process.memoryUsage().rss;
  const memDeltaMiB = (Math.max(peakRss, loadedRss) - baseRss) / MIB;
  assert.ok(memDeltaMiB < 96, `内存增量 ${memDeltaMiB.toFixed(1)} MiB 超过 96 MiB`);

  scorer.close();

  // ---- 持久化体积 ----
  let dbBytes = statSync(dbPath).size;
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(dbPath + suffix)) dbBytes += statSync(dbPath + suffix).size;
  }
  const dbMiB = dbBytes / MIB;
  assert.ok(dbMiB < 150, `持久化体积 ${dbMiB.toFixed(1)} MiB 超过 150 MiB`);

  // ---- 报告 ----
  t.diagnostic(`插入 ${RULES} 规则 + ${RESULTS} 结果: ${insertMs.toFixed(0)}ms`);
  t.diagnostic(`全跨度查询(预热后): ${fullQueryMs.toFixed(1)}ms, 子区间查询: ${windowQueryMs.toFixed(1)}ms`);
  t.diagnostic(`内存增量(相对空库): ${memDeltaMiB.toFixed(1)} MiB`);
  t.diagnostic(`持久化体积: ${dbMiB.toFixed(1)} MiB`);
});
