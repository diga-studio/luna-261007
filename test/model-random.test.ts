import { test } from "node:test";
import { deepEqual } from "node:assert/strict";
import { WindowAggregator, WINDOW_MS, InputRecord, WindowStats } from "../src/aggregator";

/** Deterministic PRNG (mulberry32) so failures reproduce exactly. */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Independent naive reference: keep every record's highest revision in a
 *  plain map and answer queries by scanning all of it. */
class NaiveModel {
  private live = new Map<string, { revision: number; t: number; v: number }>();

  upsertBatch(records: InputRecord[]): void {
    for (const r of records) {
      const prev = this.live.get(r.recordId);
      if (prev && prev.revision >= r.revision) continue;
      this.live.set(r.recordId, { revision: r.revision, t: r.eventTimeMs, v: r.value });
    }
  }

  query(endMs: number): WindowStats {
    const lo = endMs - WINDOW_MS;
    let count = 0;
    let sum = 0;
    let min: number | null = null;
    let max: number | null = null;
    for (const rec of this.live.values()) {
      if (rec.t <= lo || rec.t > endMs) continue;
      count += 1;
      sum += rec.v;
      if (min === null || rec.v < min) min = rec.v;
      if (max === null || rec.v > max) max = rec.v;
    }
    return count === 0
      ? { count: 0, mean: null, min: null, max: null }
      : { count, mean: sum / count, min, max };
  }
}

test("seeded random mixed sequence matches naive model on every step", () => {
  const rand = makeRng(20261007);
  const pick = (n: number) => Math.floor(rand() * n);

  const agg = new WindowAggregator();
  const model = new NaiveModel();

  // Small id space and tight time range force heavy overlap: duplicate
  // deliveries, stale revisions and corrections all become likely.
  const ID_SPACE = 120;
  const revisions = new Map<string, number>();
  let clock = 5_000_000;

  const checkQuery = (endMs: number) => {
    deepEqual(agg.query(endMs), model.query(endMs), `query(${endMs})`);
  };

  for (let step = 0; step < 4000; step++) {
    const op = pick(10);
    if (op < 6) {
      // upsert batch of 1..20 records: fresh inserts, duplicates of what was
      // already sent, stale revisions, and corrections (higher revision with
      // new time/value).
      const batch: InputRecord[] = [];
      const n = 1 + pick(20);
      for (let i = 0; i < n; i++) {
        const id = `rec-${pick(ID_SPACE)}`;
        const known = revisions.get(id);
        const roll = rand();
        let revision: number;
        if (known === undefined) {
          revision = 0;
        } else if (roll < 0.35) {
          revision = known; // duplicate delivery
        } else if (roll < 0.55) {
          revision = Math.max(0, known - 1 - pick(2)); // stale revision
        } else {
          revision = known + 1 + pick(2); // correction
        }
        // Event times wander around the clock, often far out of order, and
        // frequently collide on the exact same millisecond.
        const t =
          rand() < 0.3
            ? clock
            : Math.max(0, clock - WINDOW_MS - 10_000 + pick(2 * WINDOW_MS + 20_000));
        const value = pick(2_000_001) - 1_000_000;
        batch.push({ recordId: id, revision, eventTimeMs: t, value });
        const cur = revisions.get(id);
        if (cur === undefined || revision > cur) revisions.set(id, revision);
      }
      agg.upsertBatch(batch);
      model.upsertBatch(batch);
    } else if (op < 8) {
      // Query an arbitrary endpoint: before, inside, and after the data range.
      checkQuery(Math.max(0, clock - WINDOW_MS + pick(2 * WINDOW_MS)));
    } else if (op === 8) {
      // Advance the clock so windows slide and records age out.
      clock += pick(200_000);
    } else {
      // Query exactly at the current clock and at a window edge.
      checkQuery(clock);
      checkQuery(clock + WINDOW_MS);
    }
  }

  // Final sweep: dense queries across the whole timeline, both directions.
  for (let end = clock - 2 * WINDOW_MS; end <= clock + 2 * WINDOW_MS; end += 137_911) {
    checkQuery(end);
  }
  for (let end = clock + 2 * WINDOW_MS; end >= clock - 2 * WINDOW_MS; end -= 251_803) {
    checkQuery(end);
  }
});
