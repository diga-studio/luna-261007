import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

interface ScaleMetrics {
  contracts: number;
  subContracts: number;
  totalDenominator: number;
  queryMs: number;
  subQueryMs: number;
  memDeltaMiB: number;
  dbMiB: number;
  correction: {
    beforeDenominator: number;
    afterDenominator: number;
    restoredDenominator: number;
  };
}

test(
  '规模：1万合同/10万规则/20万处理结果，50年跨度',
  { timeout: 600_000 },
  () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scorecard-scale-'));
    try {
      const child = path.join(__dirname, 'scale-child.js');
      const result = spawnSync(process.execPath, ['--expose-gc', child, dir], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      });
      if (result.status !== 0) {
        console.log(result.stdout);
        console.error(result.stderr);
        assert.fail(`scale child exited with ${result.status}`);
      }
      const line = result.stdout
        .split('\n')
        .find((l) => l.startsWith('[scale-metrics] '));
      assert.ok(line, 'missing metrics line');
      const m: ScaleMetrics = JSON.parse(line.slice('[scale-metrics] '.length));
      console.log(
        `[scale] query=${m.queryMs.toFixed(1)}ms subQuery=${m.subQueryMs.toFixed(1)}ms ` +
          `memDelta=${m.memDeltaMiB.toFixed(1)}MiB dbSize=${m.dbMiB.toFixed(1)}MiB ` +
          `contracts=${m.contracts} totalDenominator=${m.totalDenominator}`
      );

      // 覆盖全部合同，分母为正
      assert.equal(m.contracts, 10_000);
      assert.ok(m.subContracts > 0);
      assert.ok(m.totalDenominator > 0);

      // 预热后查询 < 2s
      assert.ok(m.queryMs < 2000, `query took ${m.queryMs.toFixed(1)}ms`);
      assert.ok(m.subQueryMs < 2000, `sub-range query took ${m.subQueryMs.toFixed(1)}ms`);

      // 峰值内存增量 <= 96 MiB，持久化 <= 150 MiB
      assert.ok(m.memDeltaMiB <= 96, `memory delta ${m.memDeltaMiB.toFixed(1)} MiB`);
      assert.ok(m.dbMiB <= 150, `db size ${m.dbMiB.toFixed(1)} MiB`);

      // 更正后汇总立即变化，撤销后恢复
      assert.equal(m.correction.afterDenominator, m.correction.beforeDenominator - 1);
      assert.equal(m.correction.restoredDenominator, m.correction.beforeDenominator);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
);
