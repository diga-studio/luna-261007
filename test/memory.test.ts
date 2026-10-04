import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { SnapshotRepository } from '../src/index.js';
import { makeManifest, specOf, tempDir, writeContentFile } from './helpers.js';

// 需要 --expose-gc（经 NODE_OPTIONS 传入）；无 gc 时显式跳过。
test('提交 128MiB 文件的峰值内存增量不超过 64MiB', (t) => {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (!gc) {
    t.skip('requires --expose-gc');
    return;
  }
  const dir = tempDir('snap-mem-');
  const src = tempDir('snap-src-');
  const pom = path.join(src, 'big.pom');
  const jar = path.join(src, 'big.jar');
  writeContentFile(pom, 1024, 41);
  writeContentFile(jar, 128 * 1024 * 1024, 42);

  const repo = SnapshotRepository.open(dir);
  repo.register('rel-big', makeManifest({ pom: specOf(pom), jar: specOf(jar) }));

  gc();
  gc();
  const before = process.memoryUsage().rss;
  let peak = before;
  const timer = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().rss);
  }, 5);
  repo.commit('rel-big', pom, jar);
  clearInterval(timer);
  gc();
  const delta = Math.max(peak, process.memoryUsage().rss) - before;
  assert.ok(
    delta < 64 * 1024 * 1024,
    `rss delta ${(delta / 1024 / 1024).toFixed(1)}MiB exceeds 64MiB`,
  );
  assert.equal(fs.statSync(jar).size, 128 * 1024 * 1024);
  repo.close();
});
