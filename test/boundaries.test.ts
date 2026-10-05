import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WindowAggregator, WINDOW_LENGTH_MS } from '../src/aggregator';

const W = WINDOW_LENGTH_MS; // 3_600_000

test('empty aggregator reports empty window', () => {
  const agg = new WindowAggregator();
  assert.deepEqual(agg.query(1_000_000), { count: 0, mean: null, min: null, max: null });
});

test('window boundaries: (endMs - 3600000, endMs], left exclusive, right inclusive', () => {
  const agg = new WindowAggregator();
  const end = 10_000_000;
  agg.upsertBatch([
    { recordId: 'too-early', revision: 0, eventTimeMs: end - W, value: 1 }, // excluded (left open)
    { recordId: 'at-end', revision: 0, eventTimeMs: end, value: 10 }, // included (right closed)
    { recordId: 'inside', revision: 0, eventTimeMs: end - W + 1, value: 100 }, // included
    { recordId: 'too-late', revision: 0, eventTimeMs: end + 1, value: 1000 }, // excluded
  ]);
  assert.deepEqual(agg.query(end), { count: 2, mean: 55, min: 10, max: 100 });
  // One millisecond later: 'inside' slides out on the left, 'too-late' enters on the right.
  assert.deepEqual(agg.query(end + 1), { count: 2, mean: 505, min: 10, max: 1000 });
  // Querying exactly at a record's timestamp includes it.
  assert.deepEqual(agg.query(end - W), { count: 1, mean: 1, min: 1, max: 1 });
});

test('multiple recordIds sharing a timestamp are counted separately', () => {
  const agg = new WindowAggregator();
  const t = 5_000_000;
  agg.upsertBatch([
    { recordId: 'a', revision: 0, eventTimeMs: t, value: 4 },
    { recordId: 'b', revision: 0, eventTimeMs: t, value: 4 },
    { recordId: 'c', revision: 0, eventTimeMs: t, value: 4 },
  ]);
  assert.deepEqual(agg.query(t), { count: 3, mean: 4, min: 4, max: 4 });
});

test('out-of-order and duplicate revisions: only the highest revision counts', () => {
  const agg = new WindowAggregator();
  const end = 8_000_000;
  // Higher revision arrives first, then stale and duplicate revisions.
  agg.upsertBatch([
    { recordId: 'x', revision: 5, eventTimeMs: end - 100, value: 50 },
    { recordId: 'x', revision: 2, eventTimeMs: end - 200, value: 999 },
    { recordId: 'y', revision: 1, eventTimeMs: end - 300, value: 7 },
  ]);
  agg.upsertBatch([{ recordId: 'x', revision: 5, eventTimeMs: end - 100, value: 50 }]); // duplicate
  agg.upsertBatch([{ recordId: 'x', revision: 4, eventTimeMs: end - 50, value: 12345 }]); // stale
  agg.upsertBatch([{ recordId: 'y', revision: 0, eventTimeMs: end - 10, value: 888 }]); // stale
  assert.deepEqual(agg.query(end), { count: 2, mean: 28.5, min: 7, max: 50 });
  assert.equal(agg.recordCount, 2);
});

test('correcting extreme records migrates contributions across the window boundary', () => {
  const agg = new WindowAggregator();
  const end = 20_000_000;
  // Inside the window: min holder 'lo' (value -9) and max holder 'hi' (value 90).
  agg.upsertBatch([
    { recordId: 'lo', revision: 0, eventTimeMs: end - 10, value: -9 },
    { recordId: 'mid', revision: 0, eventTimeMs: end - 20, value: 30 },
    { recordId: 'hi', revision: 0, eventTimeMs: end - 30, value: 90 },
    { recordId: 'outside', revision: 0, eventTimeMs: end - W - 5000, value: 777 },
  ]);
  assert.deepEqual(agg.query(end), { count: 3, mean: 37, min: -9, max: 90 });

  // Correction 1: move the min holder out of the window (older than the left edge).
  // Correction 2: move the max holder out of the window (beyond endMs).
  // Correction 3: pull the previously outside record into the window with a new value.
  // Interleave stale revisions that must be ignored.
  agg.upsertBatch([
    { recordId: 'lo', revision: 1, eventTimeMs: end - W - 1, value: -9 }, // leaves window (left)
    { recordId: 'hi', revision: 1, eventTimeMs: end + 40, value: 90 }, // leaves window (right)
    { recordId: 'outside', revision: 1, eventTimeMs: end - 5, value: 12 }, // enters window
    { recordId: 'lo', revision: 0, eventTimeMs: end - 10, value: -9 }, // stale replay, ignored
  ]);
  // Old extremes -9 and 90 must not linger; new stats come from mid(30) + outside(12).
  assert.deepEqual(agg.query(end), { count: 2, mean: 21, min: 12, max: 30 });

  // Correct the same records again, changing both time and value back inside.
  agg.upsertBatch([
    { recordId: 'lo', revision: 2, eventTimeMs: end - 1, value: -1000 },
    { recordId: 'hi', revision: 2, eventTimeMs: end, value: 1000 },
  ]);
  assert.deepEqual(agg.query(end), { count: 4, mean: 10.5, min: -1000, max: 1000 });

  // Re-querying an older endpoint reflects the corrections too (no snapshotting).
  assert.deepEqual(agg.query(end - W - 1), { count: 0, mean: null, min: null, max: null });
});

test('correction within one batch applies in arrival order by revision', () => {
  const agg = new WindowAggregator();
  const end = 3_000_000;
  agg.upsertBatch([
    { recordId: 'r', revision: 3, eventTimeMs: end, value: 3 },
    { recordId: 'r', revision: 1, eventTimeMs: end, value: 1 },
    { recordId: 'r', revision: 2, eventTimeMs: end, value: 2 },
  ]);
  assert.deepEqual(agg.query(end), { count: 1, mean: 3, min: 3, max: 3 });
});

test('rejects invalid input and oversized batches', () => {
  const agg = new WindowAggregator();
  assert.throws(() => agg.upsertBatch([{ recordId: 'a', revision: -1, eventTimeMs: 0, value: 0 }]));
  assert.throws(() => agg.upsertBatch([{ recordId: 'a', revision: 0, eventTimeMs: -1, value: 0 }]));
  assert.throws(() => agg.upsertBatch([{ recordId: 'a', revision: 0, eventTimeMs: 1_000_000_000_001, value: 0 }]));
  assert.throws(() => agg.upsertBatch([{ recordId: 'a', revision: 0, eventTimeMs: 0, value: 1_000_001 }]));
  assert.throws(() => agg.upsertBatch([{ recordId: 'a', revision: 0, eventTimeMs: 0, value: 1.5 }]));
  const huge = Array.from({ length: 5001 }, (_, i) => ({
    recordId: `r${i}`, revision: 0, eventTimeMs: 0, value: 0,
  }));
  assert.throws(() => agg.upsertBatch(huge));
  assert.equal(agg.recordCount, 0);
});
