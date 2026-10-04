import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { importMetricsFromFile } from '../src/index.js';

const RECORD_COUNT = 2_000_000;
const DEVICE_COUNT = 128;
const TIME_SPAN_MS = 3_600_000; // 1 hour
const MAX_LATENCY_US = 10_000_000;
const QUERY_COUNT = 2_000;
const IMPORT_BUDGET_MS = 60_000;
const TOTAL_QUERY_BUDGET_MS = 5_000;
const SINGLE_QUERY_P95_BUDGET_MS = 10;
const MEMORY_BUDGET_BYTES = 1 << 30; // 1 GiB

// Deterministic PRNG (LCG) so the acceptance run is reproducible.
function makeRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x80000000;
  };
}

interface GeneratedMetrics {
  readonly deviceIndices: Uint8Array;
  readonly timestampsMs: Float64Array;
  readonly latenciesUs: Uint32Array;
}

function generateMetrics(rand: () => number): GeneratedMetrics {
  // Severely skewed device distribution: geometric weights, so the busiest
  // device emits ~50x more records than the quietest ones.
  const weights = new Float64Array(DEVICE_COUNT);
  let weightSum = 0;
  for (let d = 0; d < DEVICE_COUNT; d++) {
    weights[d] = Math.pow(0.97, d);
    weightSum += weights[d];
  }
  const cumulative = new Float64Array(DEVICE_COUNT);
  let acc = 0;
  for (let d = 0; d < DEVICE_COUNT; d++) {
    acc += weights[d] / weightSum;
    cumulative[d] = acc;
  }
  const pickDevice = (): number => {
    const r = rand();
    let lo = 0;
    let hi = DEVICE_COUNT - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cumulative[mid] < r) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  const deviceIndices = new Uint8Array(RECORD_COUNT);
  const timestampsMs = new Float64Array(RECORD_COUNT);
  const latenciesUs = new Uint32Array(RECORD_COUNT);
  for (let i = 0; i < RECORD_COUNT; i++) {
    deviceIndices[i] = pickDevice();
    // Exactly uniform timestamps: a range covering fraction f of the span
    // covers ~f of all records.
    timestampsMs[i] = Math.floor((i * TIME_SPAN_MS) / RECORD_COUNT);
    // Highly dispersed latencies across the whole 0..10^7 us domain.
    latenciesUs[i] =
      i % 7 === 0 ? Math.floor(rand() * (MAX_LATENCY_US + 1)) : Math.floor(rand() * 1000);
  }
  // Shuffle record order: input order must not matter.
  for (let i = RECORD_COUNT - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmpD = deviceIndices[i];
    deviceIndices[i] = deviceIndices[j];
    deviceIndices[j] = tmpD;
    const tmpT = timestampsMs[i];
    timestampsMs[i] = timestampsMs[j];
    timestampsMs[j] = tmpT;
    const tmpL = latenciesUs[i];
    latenciesUs[i] = latenciesUs[j];
    latenciesUs[j] = tmpL;
  }
  return { deviceIndices, timestampsMs, latenciesUs };
}

function writeMetricsFile(file: string, metrics: GeneratedMetrics): void {
  // Write in chunks so the test harness itself stays well under the memory budget.
  const CHUNK = 200_000;
  writeFileSync(file, '');
  const lines = new Array<string>(CHUNK);
  for (let base = 0; base < RECORD_COUNT; base += CHUNK) {
    const size = Math.min(CHUNK, RECORD_COUNT - base);
    for (let i = 0; i < size; i++) {
      const k = base + i;
      lines[i] = `gw-${metrics.deviceIndices[k]},${metrics.timestampsMs[k]},${metrics.latenciesUs[k]}`;
    }
    appendFileSync(file, lines.slice(0, size).join('\n') + '\n');
  }
}

test('scale acceptance: 2M records, 128 devices, 2000 range queries', () => {
  const rand = makeRandom(20261005);
  const metrics = generateMetrics(rand);
  const { deviceIndices, timestampsMs, latenciesUs } = metrics;

  const dir = mkdtempSync(join(tmpdir(), 'latency-scale-'));
  const file = join(dir, 'metrics.csv');
  try {
    writeMetricsFile(file, metrics);

    const importStart = performance.now();
    const dataset = importMetricsFromFile(file);
    const importMs = performance.now() - importStart;
    assert.equal(dataset.recordCount, RECORD_COUNT);
    assert.equal(dataset.deviceIds.length, DEVICE_COUNT);
    assert.ok(
      importMs <= IMPORT_BUDGET_MS,
      `import took ${importMs.toFixed(0)}ms, budget ${IMPORT_BUDGET_MS}ms`,
    );
    const rssAfterImport = process.memoryUsage().rss;
    assert.ok(
      rssAfterImport <= MEMORY_BUDGET_BYTES,
      `rss after import ${(rssAfterImport / 2 ** 30).toFixed(2)}GiB exceeds 1GiB`,
    );

    // 2000 all-device queries, each covering 50%-90% of all records,
    // every query hitting a distinct record set.
    const durations = new Float64Array(QUERY_COUNT);
    let totalRecordsMatched = 0;
    const queryStart = performance.now();
    for (let q = 0; q < QUERY_COUNT; q++) {
      const coverage = 0.5 + rand() * 0.4;
      const widthMs = Math.floor(TIME_SPAN_MS * coverage);
      const maxStart = TIME_SPAN_MS - widthMs;
      const startMs = Math.floor(rand() * (maxStart + 1));
      const endMs = startMs + widthMs;
      const t0 = performance.now();
      const stats = dataset.query({ startMs, endMs });
      durations[q] = performance.now() - t0;
      totalRecordsMatched += stats.count;
      assert.ok(stats.p50 !== null && stats.p95 !== null && stats.p99 !== null);
      assert.ok(stats.count >= RECORD_COUNT * 0.45, `coverage too low: ${stats.count}`);
    }
    const totalQueryMs = performance.now() - queryStart;
    const sortedDurations = Array.from(durations).sort((a, b) => a - b);
    const p95QueryMs = sortedDurations[Math.ceil(QUERY_COUNT * 0.95) - 1];
    const avgMatched = totalRecordsMatched / QUERY_COUNT;
    assert.ok(
      avgMatched >= RECORD_COUNT * 0.5 && avgMatched <= RECORD_COUNT * 0.9,
      `average matched records ${avgMatched} outside 50%-90% band`,
    );
    assert.ok(
      totalQueryMs <= TOTAL_QUERY_BUDGET_MS,
      `2000 queries took ${totalQueryMs.toFixed(0)}ms, budget ${TOTAL_QUERY_BUDGET_MS}ms`,
    );
    assert.ok(
      p95QueryMs <= SINGLE_QUERY_P95_BUDGET_MS,
      `single-query p95 ${p95QueryMs.toFixed(2)}ms exceeds ${SINGLE_QUERY_P95_BUDGET_MS}ms`,
    );

    const rssAfterQueries = process.memoryUsage().rss;
    assert.ok(
      rssAfterQueries <= MEMORY_BUDGET_BYTES,
      `rss after queries ${(rssAfterQueries / 2 ** 30).toFixed(2)}GiB exceeds 1GiB`,
    );

    // Correctness spot-check on the scale dataset: brute-force a handful of
    // ranges straight from the generated typed arrays.
    for (let trial = 0; trial < 5; trial++) {
      const startMs = Math.floor(rand() * (TIME_SPAN_MS / 2));
      const endMs = startMs + 1 + Math.floor(rand() * (TIME_SPAN_MS / 2));
      const deviceId = trial % 2 === 0 ? undefined : `gw-${Math.floor(rand() * DEVICE_COUNT)}`;
      const matched: number[] = [];
      for (let i = 0; i < RECORD_COUNT; i++) {
        const t = timestampsMs[i];
        if (t < startMs || t >= endMs) continue;
        if (deviceId !== undefined && deviceIndices[i] !== Number(deviceId.slice(3))) continue;
        matched.push(latenciesUs[i]);
      }
      matched.sort((a, b) => a - b);
      const n = matched.length;
      const actual = dataset.query({ startMs, endMs, deviceId });
      assert.equal(actual.count, n, `trial ${trial} count`);
      assert.equal(actual.throughputPerSec, n / ((endMs - startMs) / 1000), `trial ${trial} throughput`);
      const pick = (p: number) => (n === 0 ? null : matched[Math.ceil(n * p) - 1]);
      assert.equal(actual.p50, pick(0.5), `trial ${trial} p50`);
      assert.equal(actual.p95, pick(0.95), `trial ${trial} p95`);
      assert.equal(actual.p99, pick(0.99), `trial ${trial} p99`);
    }

    console.log(
      `  import=${importMs.toFixed(0)}ms, 2000 queries=${totalQueryMs.toFixed(0)}ms, ` +
        `query p95=${p95QueryMs.toFixed(2)}ms, rss=${(rssAfterQueries / 2 ** 30).toFixed(2)}GiB`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
