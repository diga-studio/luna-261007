/**
 * 性能测量子进程。
 * 模式 build:   构造账册并封存（耗时不计入验收）。
 * 模式 measure: 全新进程中从关闭状态打开账册、初始化并生成两份报告，测量耗时与内存增量。
 * 用法:
 *   node dist/perf/child.js build   <dir> <totalEvents> <recordCount> <targetEvents>
 *   node --expose-gc dist/perf/child.js measure <dir>
 */
import { CustodyLedger } from '../src/ledger.js';
import { verifyReport } from '../src/report.js';

const [mode, dir, totalArg, recordsArg, targetArg] = process.argv.slice(2);
const TARGET = 'record-00000';
const MISSING = 'no-such-record';
const BASE_TS = 1_700_000_000;

if (mode === 'build') {
  const total = Number(totalArg);
  const recordCount = Number(recordsArg);
  const targetEvents = Number(targetArg);
  const perRecord = Math.floor((total - targetEvents) / (recordCount - 1));
  const body128 = Buffer.alloc(128, 0x42);
  const ledger = CustodyLedger.open(dir);
  const counts: number[] = [];
  for (let r = 0; r < recordCount; r++) counts.push(r === 0 ? targetEvents : perRecord);
  const maxN = Math.max(...counts);
  let seq = 0;
  for (let j = 0; j < maxN; j++) {
    for (let r = 0; r < recordCount; r++) {
      if (j >= counts[r]) continue;
      seq++;
      const rid = 'record-' + String(r).padStart(5, '0');
      ledger.appendEvent({
        recordId: rid,
        timestamp: BASE_TS + (seq % 17), // 大量同秒事件
        actor: 'auditor-' + (seq % 31),
        body: r === 0 ? body128 : `ev-${seq}`,
      });
    }
  }
  ledger.seal();
  ledger.close();
} else if (mode === 'measure') {
  if (global.gc) global.gc();
  const memBefore = process.memoryUsage();
  const t0 = performance.now();
  const ledger = CustodyLedger.open(dir);
  const credential = ledger.credential();
  const report = ledger.generateReport(TARGET);
  const emptyReport = ledger.generateReport(MISSING);
  const t1 = performance.now();
  if (global.gc) global.gc();
  const memAfter = process.memoryUsage();
  ledger.close();

  const result = {
    elapsedMs: t1 - t0,
    rssDelta: memAfter.rss - memBefore.rss,
    heapDelta: memAfter.heapUsed - memBefore.heapUsed,
    reportEvents: report.events.length,
    okTarget: verifyReport(credential, TARGET, report),
    okEmpty: verifyReport(credential, MISSING, emptyReport),
    proofBytes: Buffer.byteLength(JSON.stringify(report.proof)),
    emptyProofBytes: Buffer.byteLength(JSON.stringify(emptyReport.proof)),
    credentialBytes: credential.length,
  };
  console.log(JSON.stringify(result));
} else {
  console.error(`unknown mode: ${mode}`);
  process.exit(1);
}
