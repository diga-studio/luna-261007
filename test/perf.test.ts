import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';

/**
 * 规模与性能验证：在堆受限（--max-old-space-size=224，总堆目标 <256MiB）的子进程中
 * 运行完整预检，验证 5 秒内完成且报告不超过 10000 段。
 */
test('完整规模预检：5 秒内完成、堆内存低于 256MiB、报告不超 10000 段', () => {
  const worker = path.join(__dirname, 'perf-worker.js');
  const stdout = execFileSync(
    process.execPath,
    ['--max-old-space-size=224', '--expose-gc', worker],
    { encoding: 'utf8', timeout: 120_000 },
  );
  const stats = JSON.parse(stdout.trim()) as {
    elapsedMs: number;
    segments: number;
    heapUsedMiB: number;
    heapDeltaMiB: number;
  };
  console.log(
    `perf: ${stats.elapsedMs}ms, segments=${stats.segments}, heapUsed=${stats.heapUsedMiB}MiB, delta=${stats.heapDeltaMiB}MiB`,
  );
  assert.ok(stats.elapsedMs < 5000, `预检耗时 ${stats.elapsedMs}ms 超过 5 秒`);
  assert.ok(stats.segments <= 10000, `报告段数 ${stats.segments} 超过 10000`);
  assert.ok(stats.heapUsedMiB < 256, `堆内存 ${stats.heapUsedMiB}MiB 超过 256MiB`);
  assert.ok(stats.segments > 0, '应产生冲突段');
});
