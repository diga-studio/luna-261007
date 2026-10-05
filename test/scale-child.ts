/**
 * 规模用例子进程：在独立进程内完成数据装载与查询，
 * 相对空库基线测量峰值内存增量、查询耗时与持久化大小。
 * 结果以 [scale-metrics] 前缀的 JSON 行输出，由 scale.test.ts 断言。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { openDatabase } from '../src/db';
import { Scorecard } from '../src/scorecard';
import { countPeriodsInRange, periodDueDate } from '../src/dates';
import { Frequency } from '../src/types';

const CONTRACTS = 10_000;
const RULES = 100_000;
const OUTCOMES = 200_000;

function main(): void {
  const dir = process.argv[2];
  if (!dir) throw new Error('usage: scale-child <workdir>');
  const dbPath = path.join(dir, 'scale.db');
  const gc = (global as { gc?: () => void }).gc;

  let seed = 20241007;
  const rand = () => {
    // mulberry32：32 位状态，避免 64 位乘法的精度损失
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const freqs: Frequency[] = ['once', 'monthly', 'quarterly', 'yearly'];

  const db = openDatabase(dbPath);
  const sc = new Scorecard(db);
  gc?.();
  const baselineRss = process.memoryUsage().rss;
  let peakRss = baselineRss;
  const sample = () => {
    gc?.();
    const rss = process.memoryUsage().rss;
    if (rss > peakRss) peakRss = rss;
  };

  // ---- 登记 10 万条规则（50 年跨度） ----
  const insertRule = db.prepare(
    'INSERT INTO rules (contract_id, first_due_date, end_date, frequency) VALUES (?, ?, ?, ?)'
  );
  const metaFirst: string[] = new Array(RULES);
  const metaEnd: string[] = new Array(RULES);
  const metaFreq: Frequency[] = new Array(RULES);
  db.exec('BEGIN');
  for (let i = 0; i < RULES; i++) {
    const y = 2024 + Math.floor(rand() * 45);
    const m = 1 + Math.floor(rand() * 12);
    const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const d = 1 + Math.floor(rand() * dim);
    const first = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const end = `${Math.min(y + 1 + Math.floor(rand() * 9), 2074)}-12-31`;
    const freq = freqs[Math.floor(rand() * freqs.length)];
    insertRule.run(`C${1 + (i % CONTRACTS)}`, first, end, freq);
    metaFirst[i] = first;
    metaEnd[i] = end;
    metaFreq[i] = freq;
  }
  db.exec('COMMIT');
  sample();

  // ---- 登记 20 万条处理结果（确定性生成，无需去重集合） ----
  db.exec('BEGIN');
  let inserted = 0;
  for (let round = 0; inserted < OUTCOMES; round++) {
    for (let idx = 0; idx < RULES && inserted < OUTCOMES; idx++) {
      const first = metaFirst[idx];
      const total = countPeriodsInRange(first, metaEnd[idx], metaFreq[idx], first, metaEnd[idx]);
      if (total <= round) continue;
      const due = periodDueDate(first, metaFreq[idx], round);
      const mod = idx % 3;
      if (mod === 0) {
        sc.recordOutcome(idx + 1, due, { kind: 'completed', completedDate: due }); // 按时
      } else if (mod === 1) {
        sc.recordOutcome(idx + 1, due, { kind: 'completed', completedDate: '2099-01-01' }); // 逾期
      } else {
        sc.recordOutcome(idx + 1, due, { kind: 'waived' });
      }
      inserted++;
    }
  }
  db.exec('COMMIT');
  sample();

  // ---- 预先选定待更正的期次，然后释放生成期使用的元数据 ----
  const victimRule = 1 + Math.floor(rand() * RULES);
  const vFirst = metaFirst[victimRule - 1];
  const vEnd = metaEnd[victimRule - 1];
  const vFreq = metaFreq[victimRule - 1];
  const victimDue = periodDueDate(vFirst, vFreq, 0);
  const victimContract = `C${1 + ((victimRule - 1) % CONTRACTS)}`;
  metaFirst.length = 0;
  metaEnd.length = 0;
  metaFreq.length = 0;
  sample();

  // ---- 预热后查询：覆盖全部合同的全量区间 + 任意子区间 ----
  const rangeStart = '2024-01-01';
  const rangeEnd = '2074-12-31';
  sc.summarize(rangeStart, rangeEnd); // 预热
  sc.summarize('2030-01-01', '2034-12-31'); // 预热子区间
  gc?.();
  const t0 = performance.now();
  const summaries = sc.summarize(rangeStart, rangeEnd);
  const queryMs = performance.now() - t0;
  sample();
  const t1 = performance.now();
  const subSummaries = sc.summarize('2030-06-15', '2032-02-29');
  const subQueryMs = performance.now() - t1;
  sample();
  const totalDenominator = summaries.reduce((a, s) => a + s.denominator, 0);

  // ---- 更正处理结果后立即重查，结果必须变化 ----
  sc.revokeOutcome(victimRule, victimDue); // 清除可能已有的结果，取干净基线
  const before = sc.summarize(rangeStart, rangeEnd).find((s) => s.contractId === victimContract)!;
  sc.recordOutcome(victimRule, victimDue, { kind: 'waived' });
  const after = sc.summarize(rangeStart, rangeEnd).find((s) => s.contractId === victimContract)!;
  sc.revokeOutcome(victimRule, victimDue);
  const restored = sc.summarize(rangeStart, rangeEnd).find((s) => s.contractId === victimContract)!;
  sample();

  db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  sample();
  const dbBytes = fs.statSync(dbPath).size;
  sc.close();

  const metrics = {
    contracts: summaries.length,
    subContracts: subSummaries.length,
    totalDenominator,
    queryMs,
    subQueryMs,
    memDeltaMiB: (peakRss - baselineRss) / (1024 * 1024),
    dbMiB: dbBytes / (1024 * 1024),
    correction: {
      beforeDenominator: before.denominator,
      afterDenominator: after.denominator,
      restoredDenominator: restored.denominator,
    },
  };
  console.log(`[scale-metrics] ${JSON.stringify(metrics)}`);
}

main();
