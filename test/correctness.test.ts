import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDataset, importMetrics } from '../src/index.ts';
import type { ParsedMetrics } from '../src/index.ts';
import type { QueryStats } from '../src/index.ts';

type RawRecord = [deviceId: string, timestampMs: number, latencyUs: number];

function makeParsed(records: RawRecord[]): ParsedMetrics {
  const deviceIds = [...new Set(records.map((r) => r[0]))];
  const lookup = new Map(deviceIds.map((id, i) => [id, i]));
  return {
    deviceIds,
    deviceIndex: Uint32Array.from(records.map((r) => lookup.get(r[0])!)),
    timestampsMs: Float64Array.from(records.map((r) => r[1])),
    latenciesUs: Uint32Array.from(records.map((r) => r[2])),
  };
}

function quantile(sorted: number[], numerator: number, denominator: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.ceil((sorted.length * numerator) / denominator) - 1]!;
}

function bruteForce(
  records: RawRecord[],
  startMs: number,
  endMs: number,
  deviceId?: string,
): QueryStats {
  const latencies = records
    .filter(
      (r) =>
        r[1] >= startMs &&
        r[1] < endMs &&
        (deviceId === undefined || r[0] === deviceId),
    )
    .map((r) => r[2])
    .sort((a, b) => a - b);
  if (latencies.length === 0) {
    return { count: 0, throughputPerSec: 0, p50: null, p95: null, p99: null };
  }
  return {
    count: latencies.length,
    throughputPerSec: latencies.length / ((endMs - startMs) / 1000),
    p50: quantile(latencies, 50, 100),
    p95: quantile(latencies, 95, 100),
    p99: quantile(latencies, 99, 100),
  };
}

test('duplicate timestamps at both range boundaries: start inclusive, end exclusive', () => {
  const records: RawRecord[] = [
    ['a', 1000, 10],
    ['a', 1000, 20],
    ['b', 1000, 30],
    ['a', 2000, 40],
    ['b', 2000, 50],
  ];
  const ds = buildDataset(makeParsed(records));
  const stats = ds.query({ startMs: 1000, endMs: 2000 });
  assert.equal(stats.count, 3);
  assert.equal(stats.throughputPerSec, 3);
  assert.deepEqual(
    [stats.p50, stats.p95, stats.p99],
    [20, 30, 30],
  );
  // Records exactly at endMs are excluded; at startMs included.
  assert.equal(ds.query({ startMs: 999, endMs: 1000 }).count, 0);
  assert.equal(ds.query({ startMs: 2000, endMs: 2001 }).count, 2);
});

test('zero latency and repeated latencies each occupy positions', () => {
  const records: RawRecord[] = [
    ['a', 0, 0],
    ['a', 1, 0],
    ['a', 2, 7],
    ['a', 3, 7],
    ['a', 4, 7],
  ];
  const ds = buildDataset(makeParsed(records));
  const stats = ds.query({ startMs: 0, endMs: 5, deviceId: 'a' });
  // sorted: [0, 0, 7, 7, 7]; p50 -> 3rd, p95/p99 -> 5th
  assert.deepEqual([stats.p50, stats.p95, stats.p99], [7, 7, 7]);
  assert.equal(stats.count, 5);
  assert.equal(stats.throughputPerSec, 1000); // 5 records / 0.005 s
});

test('empty range yields zero count/throughput and null quantiles', () => {
  const ds = buildDataset(makeParsed([['a', 100, 5]]));
  assert.deepEqual(ds.query({ startMs: 200, endMs: 300 }), {
    count: 0,
    throughputPerSec: 0,
    p50: null,
    p95: null,
    p99: null,
  });
  // Range that matches only other devices is also empty for this device.
  assert.equal(ds.query({ startMs: 0, endMs: 1000, deviceId: 'a' }).count, 1);
});

test('heavily skewed devices: every inference weighs equally across devices', () => {
  const records: RawRecord[] = [];
  for (let i = 0; i < 99; i++) records.push(['busy', 1000 + i, 10]);
  records.push(['quiet', 1500, 1000]);
  const ds = buildDataset(makeParsed(records));

  const all = ds.query({ startMs: 1000, endMs: 2000 });
  assert.equal(all.count, 100);
  // 99 of 100 values are 10us, so all three quantiles are 10.
  assert.deepEqual([all.p50, all.p95, all.p99], [10, 10, 10]);

  const quiet = ds.query({ startMs: 1000, endMs: 2000, deviceId: 'quiet' });
  assert.equal(quiet.count, 1);
  assert.deepEqual([quiet.p50, quiet.p95, quiet.p99], [1000, 1000, 1000]);

  const busy = ds.query({ startMs: 1000, endMs: 2000, deviceId: 'busy' });
  assert.equal(busy.count, 99);
  assert.deepEqual([busy.p50, busy.p95, busy.p99], [10, 10, 10]);
});

test('throughput divides by whole range seconds, including silent gaps', () => {
  const records: RawRecord[] = [
    ['a', 0, 100],
    ['a', 9999, 200],
  ];
  const ds = buildDataset(makeParsed(records));
  const stats = ds.query({ startMs: 0, endMs: 10000 });
  assert.equal(stats.count, 2);
  assert.equal(stats.throughputPerSec, 0.2);
  // Millisecond-precise bounds: not rounded to whole seconds.
  const tight = ds.query({ startMs: 1, endMs: 1000 });
  assert.equal(tight.count, 0);
  const half = ds.query({ startMs: 0, endMs: 500 });
  assert.equal(half.count, 1);
  assert.equal(half.throughputPerSec, 2);
});

test('quantile positions follow ceil(N * p) exactly', () => {
  // N=20: p50 -> 10th, p95 -> 19th, p99 -> 20th (1-based).
  const records: RawRecord[] = [];
  for (let i = 1; i <= 20; i++) records.push(['a', i, i * 100]);
  const ds = buildDataset(makeParsed(records));
  const stats = ds.query({ startMs: 1, endMs: 21 });
  assert.deepEqual([stats.p50, stats.p95, stats.p99], [1000, 1900, 2000]);
});

test('invalid queries are rejected', () => {
  const ds = buildDataset(makeParsed([['a', 0, 1]]));
  assert.throws(() => ds.query({ startMs: 10, endMs: 10 }), RangeError);
  assert.throws(() => ds.query({ startMs: 11, endMs: 10 }), RangeError);
  assert.throws(() => ds.query({ startMs: 0.5, endMs: 10 }), TypeError);
  assert.throws(() => ds.query({ startMs: 0, endMs: 10, deviceId: 'nope' }), /unknown device/);
});

test('randomized cross-check against brute force', () => {
  let seed = 0xC0FFEE;
  const rand = (n: number): number => {
    seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
    return seed % n;
  };
  const devices = ['d0', 'd1', 'd2', 'd3', 'd4'];
  for (let trial = 0; trial < 300; trial++) {
    const records: RawRecord[] = [];
    const n = 1 + rand(400);
    for (let i = 0; i < n; i++) {
      const latency = trial % 4 === 0 ? rand(3) : rand(10_000_001);
      records.push([devices[rand(5)]!, rand(10_000), latency]);
    }
    const ds = buildDataset(makeParsed(records));
    const startMs = rand(10_000);
    const endMs = startMs + 1 + rand(10_000 - startMs);
    const present = [...new Set(records.map((r) => r[0]))];
    const deviceId = trial % 3 === 0 ? present[rand(present.length)] : undefined;
    assert.deepEqual(
      ds.query({ startMs, endMs, deviceId }),
      bruteForce(records, startMs, endMs, deviceId),
      `trial ${trial}`,
    );
  }
});

test('file import: header tolerated, empty lines skipped, order irrelevant', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'latency-test-'));
  try {
    const file = join(dir, 'metrics.csv');
    const lines = [
      'device,timestamp_ms,latency_us',
      'gw-1,1700000000000,120',
      '',
      'gw-2,1699999999000,0',
      'gw-1,1700000000000,120',
      'gw-2,1700000000500,10000000',
    ];
    await writeFile(file, lines.join('\n'));
    const ds = await importMetrics(file);
    assert.equal(ds.recordCount, 4);
    assert.deepEqual([...ds.deviceIds].sort(), ['gw-1', 'gw-2']);
    const stats = ds.query({ startMs: 1699999999000, endMs: 1700000000501 });
    assert.equal(stats.count, 4);
    // sorted latencies: [0, 120, 120, 10000000]
    assert.deepEqual([stats.p50, stats.p95, stats.p99], [120, 10000000, 10000000]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('file import rejects malformed lines and out-of-range latencies', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'latency-test-'));
  try {
    const bad1 = join(dir, 'bad1.csv');
    await writeFile(bad1, 'a,1,10\nbroken-line\n');
    await assert.rejects(() => importMetrics(bad1), /line 2/);

    const bad2 = join(dir, 'bad2.csv');
    await writeFile(bad2, 'a,1,10000001\n');
    await assert.rejects(() => importMetrics(bad2), /line 1/);

    const bad3 = join(dir, 'bad3.csv');
    await writeFile(bad3, 'a,1,-5\n');
    await assert.rejects(() => importMetrics(bad3), /line 1/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
