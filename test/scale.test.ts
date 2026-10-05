import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WindowAggregator, WindowStats, WINDOW_LENGTH_MS } from '../src/aggregator';

/**
 * Scale test: 500k distinct recordIds, 100k queries, >= 50k queries
 * interleaved with small correction batches. All expected statistics are
 * derived from closed-form bookkeeping, never from the aggregator itself.
 */

const W = WINDOW_LENGTH_MS;
const BASE = 1_000_000_000;
const MONOTONIC_COUNT = 400_000; // t = BASE + i (strictly increasing)
const SHARED_COUNT = 100_000; // all at one identical timestamp
const TOTAL = MONOTONIC_COUNT + SHARED_COUNT; // 500_000 distinct recordIds
const SHARED_T = BASE + 500_000;
const NOW = BASE + 600_000; // every record lands inside (NOW - W, NOW]
const OUT_T = NOW - W - 1; // outside any window ending at or before NOW
const INTERLEAVED_QUERIES = 50_000;
const TAIL_QUERIES = 50_000;
const CORRECTIONS_PER_BATCH = 4;

const monoId = (i: number): string => `m-${i}`;
const sharedId = (i: number): string => `s-${i}`;

/** Value formula for never-corrected records; extremes pinned at i = 0 and 1. */
function initialValue(i: number): number {
  if (i === 0) return -1_000_000;
  if (i === 1) return 1_000_000;
  return (i % 1000) - 500;
}

function prefixSumMonotonic(count: number): number {
  // Sum of initialValue(i) for i in [0, count). Only used for small prefixes
  // in pre-correction checks, so a direct loop is fine.
  let sum = 0;
  for (let i = 0; i < count; i += 1) sum += initialValue(i);
  return sum;
}

test('scale: 500k records, 100k queries, interleaved corrections, derivable stats', { timeout: 300_000 }, () => {
  const agg = new WindowAggregator();

  // Phase 1: monotonic timestamps, batches of 5000.
  let totalSum = 0;
  for (let start = 0; start < MONOTONIC_COUNT; start += 5000) {
    const batch = [];
    for (let i = start; i < start + 5000; i += 1) {
      const value = initialValue(i);
      totalSum += value;
      batch.push({ recordId: monoId(i), revision: 0, eventTimeMs: BASE + i, value });
    }
    agg.upsertBatch(batch);
  }
  // Phase 2: 100k records sharing one identical timestamp.
  let sharedSum = 0;
  for (let start = 0; start < SHARED_COUNT; start += 5000) {
    const batch = [];
    for (let i = start; i < start + 5000; i += 1) {
      const value = ((i * 7) % 1000) - 500;
      sharedSum += value;
      batch.push({ recordId: sharedId(i), revision: 0, eventTimeMs: SHARED_T, value });
    }
    agg.upsertBatch(batch);
  }
  totalSum += sharedSum;
  assert.equal(agg.recordCount, TOTAL);

  // Pre-correction derivable checks, including a mid-timeline prefix window
  // and a window holding exactly the 100k same-timestamp records.
  const prefixEnd = BASE + 199_999;
  assert.deepEqual(agg.query(prefixEnd), {
    count: 200_000,
    mean: prefixSumMonotonic(200_000) / 200_000,
    min: -1_000_000,
    max: 1_000_000,
  });
  assert.deepEqual(agg.query(SHARED_T), {
    count: TOTAL,
    mean: totalSum / TOTAL,
    min: -1_000_000,
    max: 1_000_000,
  });
  assert.deepEqual(agg.query(BASE - 1), { count: 0, mean: null, min: null, max: null });

  // Bookkeeping for the interleaved phase. Reserved extremes (i = 0, 1) are
  // never corrected, so min/max stay pinned at -1_000_000 / 1_000_000.
  const revisions = new Map<string, number>();
  const correctedValue = new Map<string, number>(); // id -> current value
  const correctedIn = new Set<string>(); // ids currently inside the NOW window
  let expectedCount = TOTAL;
  let expectedSum = totalSum;

  const currentValueOf = (id: string, monoIndex: number): number =>
    correctedValue.get(id) ?? initialValue(monoIndex);

  const expectedNow = (): WindowStats => ({
    count: expectedCount,
    mean: expectedSum / expectedCount,
    min: -1_000_000,
    max: 1_000_000,
  });

  // Bookkeeping for records corrected OUT of the NOW window (all at OUT_T).
  let outCount = 0;
  let outSum = 0;
  let outPos = 0; // moved-out records with value +250_000
  let outNeg = 0; // moved-out records with value -250_000
  const expectedOut = (): WindowStats => {
    if (outCount === 0) return { count: 0, mean: null, min: null, max: null };
    return {
      count: outCount,
      mean: outSum / outCount,
      min: outNeg > 0 ? -250_000 : 250_000,
      max: outPos > 0 ? 250_000 : -250_000,
    };
  };

  // Phase 3: 50k iterations of (small correction batch -> query at NOW).
  for (let iter = 0; iter < INTERLEAVED_QUERIES; iter += 1) {
    const batch = [];
    for (let k = 0; k < CORRECTIONS_PER_BATCH; k += 1) {
      const monoIndex = 2 + ((iter * CORRECTIONS_PER_BATCH + k) % (MONOTONIC_COUNT - 2));
      const id = monoId(monoIndex);
      const oldValue = currentValueOf(id, monoIndex);
      const wasIn = !correctedValue.has(id) || correctedIn.has(id);
      if (wasIn) {
        expectedCount -= 1;
        expectedSum -= oldValue;
      }
      // Alternate: move out of the window / bring back in with a new value.
      const moveIn = (iter + k) % 2 === 0;
      const newValue = (iter + k) % 4 === 0 ? 250_000 : -250_000;
      const newT = moveIn ? NOW : OUT_T;
      const revision = (revisions.get(id) ?? 0) + 1;
      revisions.set(id, revision);
      // Remove the previous OUT contribution if the record was moved out.
      if (correctedValue.has(id) && !correctedIn.has(id)) {
        const prevValue = correctedValue.get(id) as number;
        outCount -= 1;
        outSum -= prevValue;
        if (prevValue > 0) outPos -= 1; else outNeg -= 1;
      }
      correctedValue.set(id, newValue);
      if (moveIn) {
        correctedIn.add(id);
        expectedCount += 1;
        expectedSum += newValue;
      } else {
        correctedIn.delete(id);
        outCount += 1;
        outSum += newValue;
        if (newValue > 0) outPos += 1; else outNeg += 1;
      }
      batch.push({ recordId: id, revision, eventTimeMs: newT, value: newValue });
      // Every 1000th batch also carries a stale duplicate that must be ignored.
      if (k === 0 && iter % 1000 === 0) {
        batch.push({ recordId: id, revision: revision - 1, eventTimeMs: BASE + monoIndex, value: oldValue });
      }
    }
    agg.upsertBatch(batch);
    assert.deepEqual(agg.query(NOW), expectedNow(), `interleaved iter ${iter}`);
  }

  // Phase 4: 50k more queries without writes, at endpoints with derivable
  // outcomes: NOW / NOW + 1000 cover ~all effective records; NOW - W - 1
  // covers exactly the moved-out records; BASE - W - 1 is empty.
  const empty: WindowStats = { count: 0, mean: null, min: null, max: null };
  for (let q = 0; q < TAIL_QUERIES; q += 1) {
    const slot = q % 4;
    let endMs: number;
    let expected: WindowStats;
    if (slot === 0) {
      endMs = NOW;
      expected = expectedNow();
    } else if (slot === 1) {
      endMs = NOW + 1000;
      expected = expectedNow();
    } else if (slot === 2) {
      endMs = NOW - W - 1; // window (NOW - 2W - 1, NOW - W - 1] holds only OUT_T records
      expected = expectedOut();
    } else {
      endMs = BASE - W - 1; // before every record, including moved-out ones
      expected = empty;
    }
    assert.deepEqual(agg.query(endMs), expected, `tail query ${q}`);
  }

  // Re-querying the same endpoint after all corrections still reflects them.
  assert.notDeepEqual(agg.query(NOW), { count: TOTAL, mean: totalSum / TOTAL, min: -1_000_000, max: 1_000_000 });
});
