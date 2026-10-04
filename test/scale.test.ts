import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { importMetrics } from '../src/index.ts';

const RECORD_COUNT = 2_000_000;
const DEVICE_COUNT = 128;
const QUERY_COUNT = 2000;
const TIME_WINDOW_MS = 3_600_000; // 1 hour
const BASE_MS = 1_700_000_000_000;
const IMPORT_BUDGET_MS = 60_000;
const QUERY_TOTAL_BUDGET_MS = 5_000;
const QUERY_P95_BUDGET_MS = 10;
const MEMORY_BUDGET_BYTES = 1 << 30; // 1 GiB

function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

test(
  'scale: 2M records / 128 devices, import < 60s, 2000 heavy queries < 5s, memory < 1GiB',
  { timeout: 300_000 },
  async () => {
    const rand = makeRng(0x5eed);

    // Zipf-like skew: device volumes differ by orders of magnitude.
    const weights = new Float64Array(DEVICE_COUNT);
    let weightSum = 0;
    for (let d = 0; d < DEVICE_COUNT; d++) {
      weights[d] = 1 / (d + 1);
      weightSum += weights[d]!;
    }
    const cdf = new Float64Array(DEVICE_COUNT);
    let acc = 0;
    for (let d = 0; d < DEVICE_COUNT; d++) {
      acc += weights[d]! / weightSum;
      cdf[d] = acc;
    }
    const pickDevice = (): number => {
      const u = rand();
      let lo = 0;
      let hi = DEVICE_COUNT - 1;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (cdf[mid]! < u) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    };

    // Keep raw data for brute-force spot checks.
    const rawTimestamps = new Float64Array(RECORD_COUNT);
    const rawLatencies = new Uint32Array(RECORD_COUNT);

    const dir = await mkdtemp(join(tmpdir(), 'latency-scale-'));
    const file = join(dir, 'metrics.csv');
    try {
      const out = createWriteStream(file);
      const CHUNK = 100_000;
      let buffer: string[] = [];
      for (let i = 0; i < RECORD_COUNT; i++) {
        const device = pickDevice();
        const ts = BASE_MS + Math.floor(rand() * TIME_WINDOW_MS);
        // Highly dispersed latencies across the full 0..10_000_000 range.
        const lat = rand() < 0.9 ? Math.floor(rand() * 10_000) : Math.floor(rand() * 10_000_001);
        rawTimestamps[i] = ts;
        rawLatencies[i] = lat;
        buffer.push(`gw-${device},${ts},${lat}\n`);
        if (buffer.length >= CHUNK) {
          if (!out.write(buffer.join(''))) {
            await new Promise<void>((resolve) => out.once('drain', resolve));
          }
          buffer = [];
        }
      }
      if (buffer.length > 0) out.write(buffer.join(''));
      await new Promise<void>((resolve, reject) => {
        out.end(() => resolve());
        out.once('error', reject);
      });

      const importStart = performance.now();
      const ds = await importMetrics(file);
      const importMs = performance.now() - importStart;
      assert.equal(ds.recordCount, RECORD_COUNT);
      assert.equal(ds.deviceIds.length, DEVICE_COUNT);
      assert.ok(
        importMs < IMPORT_BUDGET_MS,
        `import took ${importMs.toFixed(0)}ms, budget ${IMPORT_BUDGET_MS}ms`,
      );
      const rssAfterImport = process.memoryUsage().rss;
      assert.ok(
        rssAfterImport < MEMORY_BUDGET_BYTES,
        `rss after import ${(rssAfterImport / 2 ** 30).toFixed(2)}GiB exceeds 1GiB`,
      );

      // Query ranges via global timestamp order so each covers 50%-90%.
      const sortedTs = Float64Array.from(rawTimestamps);
      sortedTs.sort();
      const durations = new Float64Array(QUERY_COUNT);
      const queryStart = performance.now();
      for (let q = 0; q < QUERY_COUNT; q++) {
        const width = 0.52 + rand() * 0.36; // [0.52, 0.88]
        const startFrac = rand() * (1 - width - 0.01);
        const startMs = sortedTs[Math.floor(startFrac * RECORD_COUNT)]!;
        const endMs = sortedTs[Math.floor((startFrac + width) * RECORD_COUNT)]!;
        const t0 = performance.now();
        const stats = ds.query({ startMs, endMs });
        durations[q] = performance.now() - t0;
        assert.ok(
          stats.count >= 0.5 * RECORD_COUNT && stats.count <= 0.9 * RECORD_COUNT,
          `query ${q} covered ${stats.count} records, outside [50%, 90%] of total`,
        );
      }
      const totalQueryMs = performance.now() - queryStart;
      const sortedDurations = Float64Array.from(durations);
      sortedDurations.sort();
      const p95Ms = sortedDurations[Math.ceil(QUERY_COUNT * 0.95) - 1]!;
      assert.ok(
        totalQueryMs < QUERY_TOTAL_BUDGET_MS,
        `2000 queries took ${totalQueryMs.toFixed(0)}ms, budget ${QUERY_TOTAL_BUDGET_MS}ms`,
      );
      assert.ok(
        p95Ms < QUERY_P95_BUDGET_MS,
        `per-query p95 ${p95Ms.toFixed(2)}ms, budget ${QUERY_P95_BUDGET_MS}ms`,
      );
      const rssAfterQueries = process.memoryUsage().rss;
      assert.ok(
        rssAfterQueries < MEMORY_BUDGET_BYTES,
        `rss after queries ${(rssAfterQueries / 2 ** 30).toFixed(2)}GiB exceeds 1GiB`,
      );

      // Exactness spot check at scale: brute force over raw data.
      for (let s = 0; s < 5; s++) {
        const width = 0.52 + rand() * 0.36;
        const startFrac = rand() * (1 - width - 0.01);
        const startMs = sortedTs[Math.floor(startFrac * RECORD_COUNT)]!;
        const endMs = sortedTs[Math.floor((startFrac + width) * RECORD_COUNT)]!;
        const matched: number[] = [];
        for (let i = 0; i < RECORD_COUNT; i++) {
          const ts = rawTimestamps[i]!;
          if (ts >= startMs && ts < endMs) matched.push(rawLatencies[i]!);
        }
        matched.sort((a, b) => a - b);
        const stats = ds.query({ startMs, endMs });
        assert.equal(stats.count, matched.length);
        assert.equal(stats.p50, matched[Math.ceil(matched.length * 0.5) - 1]!);
        assert.equal(stats.p95, matched[Math.ceil(matched.length * 0.95) - 1]!);
        assert.equal(stats.p99, matched[Math.ceil(matched.length * 0.99) - 1]!);
        assert.equal(stats.throughputPerSec, matched.length / ((endMs - startMs) / 1000));
      }

      console.log(
        `  [scale] import ${importMs.toFixed(0)}ms, ` +
          `2000 queries total ${totalQueryMs.toFixed(0)}ms (p95 ${p95Ms.toFixed(2)}ms), ` +
          `peak rss ${(Math.max(rssAfterImport, rssAfterQueries) / 2 ** 30).toFixed(2)}GiB`,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
