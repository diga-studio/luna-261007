import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { CHUNK_SIZE, MAX_TOTAL_SIZE, TrainingMaterialStore } from '../src/index';
import { makeManifest } from './helpers/content';

const MEMORY_BUDGET = 32 * 1024 * 1024; // 32 MiB

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tms-mem-'));
}

function rss(): number {
  return process.memoryUsage().rss;
}

test('100 MiB upload completes byte-identical within 32 MiB added peak memory', () => {
  const root = tempRoot();
  try {
    // warm up the module so one-time costs (JIT, sqlite setup) are not counted
    const warm = makeManifest('warm', 'up-warm', CHUNK_SIZE, '');
    let store = TrainingMaterialStore.open(root);
    store.register({ uploadId: warm.manifest.uploadId, totalSize: warm.manifest.totalSize, sha256: warm.manifest.sha256 });
    store.receiveChunk('up-warm', 0, warm.content);
    store.finalize('up-warm');
    store.close();

    const totalSize = MAX_TOTAL_SIZE; // exactly 100 MiB
    const { manifest, content } = makeManifest('big-seed', 'up-big', totalSize, '');
    assert.equal(content.length, totalSize);

    store = TrainingMaterialStore.open(root);
    store.register({
      uploadId: manifest.uploadId,
      totalSize: manifest.totalSize,
      sha256: manifest.sha256,
    });

    let peak = rss();
    const track = () => {
      const now = rss();
      if (now > peak) peak = now;
    };
    const baseline = rss();

    const chunkCount = Math.ceil(totalSize / CHUNK_SIZE);
    for (let i = 0; i < chunkCount; i += 1) {
      const start = i * CHUNK_SIZE;
      store.receiveChunk(manifest.uploadId, i, content.subarray(start, start + CHUNK_SIZE));
      track();
    }
    const result = store.finalize(manifest.uploadId);
    track();
    store.close();

    const produced = fs.readFileSync(result.artifactPath);
    assert.ok(produced.equals(content), '100 MiB artifact must be byte-identical');

    const added = peak - baseline;
    assert.ok(
      added < MEMORY_BUDGET,
      `module added peak memory ${(added / 1024 / 1024).toFixed(1)} MiB exceeds 32 MiB budget`,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
