import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WindowAggregator, SampleRecord, WindowStats, WINDOW_LENGTH_MS } from '../src/aggregator';

/** Deterministic PRNG (mulberry32) so the sequence is reproducible. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Independent naive model: keeps every record's highest revision, scans all. */
class NaiveModel {
  private readonly effective = new Map<string, SampleRecord>();

  upsertBatch(records: readonly SampleRecord[]): void {
    for (const record of records) {
      const current = this.effective.get(record.recordId);
      if (current === undefined || record.revision > current.revision) {
        this.effective.set(record.recordId, record);
      }
    }
  }

  query(endMs: number): WindowStats {
    let count = 0;
    let sum = 0;
    let min = Infinity;
    let max = -Infinity;
    for (const record of this.effective.values()) {
      if (record.eventTimeMs > endMs - WINDOW_LENGTH_MS && record.eventTimeMs <= endMs) {
        count += 1;
        sum += record.value;
        if (record.value < min) min = record.value;
        if (record.value > max) max = record.value;
      }
    }
    if (count === 0) return { count: 0, mean: null, min: null, max: null };
    return { count, mean: sum / count, min, max };
  }
}

const SEED = 20261006;
const STEPS = 4000;
const RECORD_IDS = 120;
const TIME_SPAN_MS = 20_000_000; // ~5.5 window lengths, forces boundary crossings

test('seeded random mixed sequence matches the naive model at every step', () => {
  const rand = mulberry32(SEED);
  const agg = new WindowAggregator();
  const model = new NaiveModel();
  // Highest revision ever issued per recordId, so we can mint stale/duplicate/fresh ones.
  const issuedRevision = new Map<string, number>();

  const pickId = (): string => `rec-${Math.floor(rand() * RECORD_IDS)}`;
  const pickTime = (): number => Math.floor(rand() * TIME_SPAN_MS);
  const pickValue = (): number => Math.floor(rand() * 2_000_001) - 1_000_000;

  for (let step = 0; step < STEPS; step += 1) {
    const roll = rand();
    if (roll < 0.55) {
      // Write a small batch (1..8 records): fresh inserts, corrections,
      // duplicates and stale revisions, in random order.
      const batchSize = 1 + Math.floor(rand() * 8);
      const batch: SampleRecord[] = [];
      for (let i = 0; i < batchSize; i += 1) {
        const id = pickId();
        const highest = issuedRevision.get(id);
        const kind = rand();
        let revision: number;
        if (highest === undefined || kind < 0.45) {
          // Brand-new record or a genuine correction (higher revision).
          revision = (highest ?? -1) + 1 + Math.floor(rand() * 3);
        } else if (kind < 0.75) {
          // Duplicate of the current highest revision (same content guaranteed).
          revision = highest;
        } else {
          // Stale revision with arbitrary other content: must be ignored.
          revision = Math.floor(rand() * (highest + 1));
        }
        if (highest === undefined || revision > highest) {
          issuedRevision.set(id, revision);
        }
        batch.push({ recordId: id, revision, eventTimeMs: pickTime(), value: pickValue() });
      }
      // Duplicate content for identical (recordId, revision) is guaranteed by
      // the pipeline contract; regenerate identical content for duplicates.
      // The pipeline contract guarantees identical content for identical
      // (recordId, revision); normalize repeats within the batch accordingly.
      const seen = new Map<string, SampleRecord>();
      const normalized = batch.map((record) => {
        const key = `${record.recordId}#${record.revision}`;
        const first = seen.get(key);
        if (first !== undefined) return first;
        seen.set(key, record);
        return record;
      });
      agg.upsertBatch(normalized);
      model.upsertBatch(normalized);
    } else {
      // Query at an arbitrary endpoint, possibly jumping backwards.
      const endMs = Math.floor(rand() * (TIME_SPAN_MS + 2 * WINDOW_LENGTH_MS)) - WINDOW_LENGTH_MS;
      const expected = model.query(endMs);
      const actual = agg.query(endMs);
      assert.equal(actual.count, expected.count, `count mismatch at step ${step}, endMs=${endMs}`);
      assert.equal(actual.min, expected.min, `min mismatch at step ${step}, endMs=${endMs}`);
      assert.equal(actual.max, expected.max, `max mismatch at step ${step}, endMs=${endMs}`);
      if (expected.mean === null) {
        assert.equal(actual.mean, null, `mean mismatch at step ${step}, endMs=${endMs}`);
      } else {
        assert.ok(
          actual.mean !== null && Math.abs(actual.mean - expected.mean) < 1e-9,
          `mean mismatch at step ${step}, endMs=${endMs}: ${actual.mean} vs ${expected.mean}`,
        );
      }
    }
  }

  // Final sweep: dense queries across the whole timeline, including re-queries.
  for (let endMs = -WINDOW_LENGTH_MS; endMs <= TIME_SPAN_MS + WINDOW_LENGTH_MS; endMs += 137_911) {
    const expected = model.query(endMs);
    const actual = agg.query(endMs);
    assert.deepEqual(actual, expected, `final sweep mismatch at endMs=${endMs}`);
  }
});
