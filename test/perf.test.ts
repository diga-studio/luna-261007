import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIB = 1024 * 1024;
const KIB = 1024;

test('100万事件/10万记录：重开后生成报告，耗时≤2s、额外峰值内存≤64MiB、校验材料≤64KiB', { timeout: 900_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'custody-perf-'));
  try {
    const childPath = fileURLToPath(new URL('../perf/child.js', import.meta.url));
    // 阶段一：构造并封存 100 万事件 / 10 万记录（目标记录 100 条 × 128B 正文）
    execFileSync(process.execPath, [childPath, 'build', dir, '1000000', '100000', '100'], {
      stdio: 'inherit',
    });
    // 阶段二：全新进程，从账册未打开状态到报告生成完毕
    const out = execFileSync(process.execPath, ['--expose-gc', childPath, 'measure', dir], {
      encoding: 'utf8',
      maxBuffer: 4 * MIB,
    });
    const r = JSON.parse(out.trim());
    console.log('perf result:', r);
    assert.equal(r.reportEvents, 100, '目标记录应有 100 条事件');
    assert.ok(r.okTarget, '非空报告应通过独立验真');
    assert.ok(r.okEmpty, '空报告应通过独立验真');
    assert.ok(r.credentialBytes <= 128, `凭证 ${r.credentialBytes}B 超过 128B`);
    assert.ok(r.elapsedMs <= 2000, `打开+初始化+生成报告耗时 ${r.elapsedMs.toFixed(0)}ms 超过 2s`);
    assert.ok(r.rssDelta <= 64 * MIB, `额外峰值内存 ${(r.rssDelta / MIB).toFixed(1)}MiB 超过 64MiB`);
    assert.ok(r.proofBytes <= 64 * KIB, `非空报告校验材料 ${r.proofBytes}B 超过 64KiB`);
    assert.ok(r.emptyProofBytes <= 64 * KIB, `空报告校验材料 ${r.emptyProofBytes}B 超过 64KiB`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
