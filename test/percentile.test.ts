import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importMetricsFromFile } from '../src/index.js';
import type { Dataset, QueryStats } from '../src/index.js';

function withDataset(
  lines: Array<readonly [string, number, number]>,
  run: (dataset: Dataset) => void,
): void {
  const dir = mkdtempSync(join(tmpdir(), 'latency-test-'));
  try {
    const file = join(dir, 'metrics.csv');
    writeFileSync(file, lines.map(([d, t, l]) => `${d},${t},${l}`).join('\n') + '\n');
    run(importMetricsFromFile(file));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('exact percentiles by definition: ceil(N*p) position, 1-based', () => {
  // 10 records with latencies 1..10 microseconds.
  const lines: Array<readonly [string, number, number]> = [];
  for (let i = 1; i <= 10; i++) lines.push(['dev', 1000 + i, i]);
  withDataset(lines, (ds) => {
    const stats = ds.query({ startMs: 1000, endMs: 2000 });
    // N=10: p50 -> 5th, p95 -> ceil(9.5)=10th, p99 -> 10th smallest.
    assert.equal(stats.count, 10);
    assert.equal(stats.p50, 5);
    assert.equal(stats.p95, 10);
    assert.equal(stats.p99, 10);
    assert.equal(stats.throughputPerSec, 10 / 1);
  });
});

test('duplicate latencies each occupy a position', () => {
  // 4 records: 5,5,5,9 -> p50 = 2nd = 5, p95 = 4th = 9.
  withDataset(
    [
      ['dev', 0, 5],
      ['dev', 1, 5],
      ['dev', 2, 5],
      ['dev', 3, 9],
    ],
    (ds) => {
      const stats = ds.query({ startMs: 0, endMs: 4 });
      assert.equal(stats.count, 4);
      assert.equal(stats.p50, 5);
      assert.equal(stats.p95, 9);
      assert.equal(stats.p99, 9);
    },
  );
});

test('duplicate timestamps at both range boundaries are included/excluded correctly', () => {
  // Three records at t=100 (inclusive start) and three at t=200 (exclusive end).
  withDataset(
    [
      ['a', 100, 10],
      ['b', 100, 20],
      ['a', 100, 30],
      ['b', 200, 40],
      ['a', 200, 50],
      ['b', 200, 60],
      ['a', 150, 70],
    ],
    (ds) => {
      const stats = ds.query({ startMs: 100, endMs: 200 });
      assert.equal(stats.count, 4); // 3 at t=100 plus 1 at t=150
      assert.deepEqual(
        [stats.p50, stats.p95, stats.p99],
        [20, 70, 70],
      );
      // Range [100, 201) includes the t=200 records too.
      assert.equal(ds.query({ startMs: 100, endMs: 201 }).count, 7);
      // Range ending exactly at 100 excludes everything.
      assert.equal(ds.query({ startMs: 99, endMs: 100 }).count, 0);
    },
  );
});

test('zero latency is a valid value and is selected', () => {
  withDataset(
    [
      ['dev', 0, 0],
      ['dev', 1, 0],
      ['dev', 2, 7],
    ],
    (ds) => {
      const stats = ds.query({ startMs: 0, endMs: 3 });
      assert.equal(stats.count, 3);
      assert.equal(stats.p50, 0);
      assert.equal(stats.p95, 7);
    },
  );
});

test('empty range yields zero count, zero throughput and null percentiles', () => {
  withDataset([['dev', 1000, 5]], (ds) => {
    const stats: QueryStats = ds.query({ startMs: 2000, endMs: 3000 });
    assert.equal(stats.count, 0);
    assert.equal(stats.throughputPerSec, 0);
    assert.equal(stats.p50, null);
    assert.equal(stats.p95, null);
    assert.equal(stats.p99, null);
  });
});

test('throughput divides by full range seconds including silent gaps', () => {
  // 2 records inside a 10-second range, no reports elsewhere.
  withDataset(
    [
      ['dev', 1000, 5],
      ['dev', 8000, 5],
    ],
    (ds) => {
      const stats = ds.query({ startMs: 0, endMs: 10_000 });
      assert.equal(stats.count, 2);
      assert.equal(stats.throughputPerSec, 2 / 10);
    },
  );
});

test('heavily skewed devices: all-device percentiles weight every inference equally', () => {
  const lines: Array<readonly [string, number, number]> = [];
  for (let i = 0; i < 99; i++) lines.push(['device-a', 1000 + i, 10]);
  lines.push(['device-b', 1500, 1000]);
  withDataset(lines, (ds) => {
    const all = ds.query({ startMs: 0, endMs: 10_000 });
    assert.equal(all.count, 100);
    // N=100: p50 -> 50th, p95 -> 95th, p99 -> 99th of 99 tens and one 1000.
    assert.equal(all.p50, 10);
    assert.equal(all.p95, 10);
    assert.equal(all.p99, 10);

    const onlyB = ds.query({ startMs: 0, endMs: 10_000, deviceId: 'device-b' });
    assert.equal(onlyB.count, 1);
    assert.equal(onlyB.p50, 1000);
    assert.equal(onlyB.p95, 1000);
    assert.equal(onlyB.p99, 1000);

    const onlyA = ds.query({ startMs: 0, endMs: 10_000, deviceId: 'device-a' });
    assert.equal(onlyA.count, 99);
    assert.equal(onlyA.p50, 10);
    assert.equal(onlyA.p99, 10);
  });
});

test('single-device query only sees that device, unknown device is empty', () => {
  withDataset(
    [
      ['x', 100, 1],
      ['y', 100, 9999],
    ],
    (ds) => {
      const x = ds.query({ startMs: 0, endMs: 1000, deviceId: 'x' });
      assert.equal(x.count, 1);
      assert.equal(x.p50, 1);
      const missing = ds.query({ startMs: 0, endMs: 1000, deviceId: 'nope' });
      assert.equal(missing.count, 0);
      assert.equal(missing.p50, null);
    },
  );
});

test('query bounds must be integer milliseconds with start < end', () => {
  withDataset([['dev', 0, 1]], (ds) => {
    assert.throws(() => ds.query({ startMs: 100, endMs: 100 }), RangeError);
    assert.throws(() => ds.query({ startMs: 200, endMs: 100 }), RangeError);
    assert.throws(() => ds.query({ startMs: 0.5, endMs: 100 }), RangeError);
  });
});

test('identical lines still count as distinct inferences', () => {
  withDataset(
    [
      ['dev', 50, 5],
      ['dev', 50, 5],
      ['dev', 50, 5],
    ],
    (ds) => {
      const stats = ds.query({ startMs: 50, endMs: 51 });
      assert.equal(stats.count, 3);
      assert.equal(stats.p50, 5);
      assert.equal(stats.throughputPerSec, 3000);
    },
  );
});

test('dataset metadata exposes record count and device ids', () => {
  withDataset(
    [
      ['b', 0, 1],
      ['a', 1, 2],
    ],
    (ds) => {
      assert.equal(ds.recordCount, 2);
      assert.deepEqual([...ds.deviceIds].sort(), ['a', 'b']);
    },
  );
});

test('import rejects malformed lines and out-of-range latency', () => {
  const dir = mkdtempSync(join(tmpdir(), 'latency-test-'));
  try {
    const bad1 = join(dir, 'bad1.csv');
    writeFileSync(bad1, 'dev,1000,10000001\n');
    assert.throws(() => importMetricsFromFile(bad1), /latency/);
    const bad2 = join(dir, 'bad2.csv');
    writeFileSync(bad2, 'dev,not-a-number,5\n');
    assert.throws(() => importMetricsFromFile(bad2), /timestamp/);
    const bad3 = join(dir, 'bad3.csv');
    writeFileSync(bad3, 'no-commas-here\n');
    assert.throws(() => importMetricsFromFile(bad3), /Invalid metric line/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('randomized cross-check against brute force (all devices and per device)', () => {
  // Deterministic PRNG for reproducibility.
  let seed = 42;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x80000000;
  };
  const devices = ['d0', 'd1', 'd2', 'd3'];
  const lines: Array<readonly [string, number, number]> = [];
  for (let i = 0; i < 3000; i++) {
    lines.push([
      devices[Math.floor(rand() * devices.length)],
      Math.floor(rand() * 5000),
      Math.floor(rand() * 500),
    ]);
  }
  withDataset(lines, (ds) => {
    const brute = (startMs: number, endMs: number, deviceId?: string): QueryStats => {
      const matched = lines
        .filter(([d, t]) => t >= startMs && t < endMs && (deviceId === undefined || d === deviceId))
        .map(([, , l]) => l)
        .sort((a, b) => a - b);
      const n = matched.length;
      const pick = (p: number) => (n === 0 ? null : matched[Math.ceil(n * p) - 1]);
      return {
        count: n,
        throughputPerSec: n / ((endMs - startMs) / 1000),
        p50: pick(0.5),
        p95: pick(0.95),
        p99: pick(0.99),
      };
    };
    for (let trial = 0; trial < 300; trial++) {
      const startMs = Math.floor(rand() * 4500);
      const endMs = startMs + 1 + Math.floor(rand() * 500);
      const deviceId = trial % 3 === 0 ? devices[Math.floor(rand() * devices.length)] : undefined;
      const expected = brute(startMs, endMs, deviceId);
      const actual = ds.query({ startMs, endMs, deviceId });
      assert.deepEqual(actual, expected, `trial ${trial}: [${startMs}, ${endMs}) device=${deviceId}`);
    }
  });
});
