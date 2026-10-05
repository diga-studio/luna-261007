import { test } from "node:test";
import { equal, deepEqual } from "node:assert/strict";
import { WindowAggregator, WINDOW_MS } from "../src/aggregator";

const W = WINDOW_MS; // 3_600_000

test("empty window yields count 0 and null stats", () => {
  const agg = new WindowAggregator();
  deepEqual(agg.query(1_000_000), { count: 0, mean: null, min: null, max: null });
});

test("window boundaries: (endMs - 3600000, endMs] inclusive on the right only", () => {
  const agg = new WindowAggregator();
  const end = 10_000_000;
  agg.upsertBatch([
    { recordId: "at-left-edge-excluded", revision: 0, eventTimeMs: end - W, value: 1 },
    { recordId: "just-inside-left", revision: 0, eventTimeMs: end - W + 1, value: 2 },
    { recordId: "at-right-edge", revision: 0, eventTimeMs: end, value: 3 },
    { recordId: "just-past-right", revision: 0, eventTimeMs: end + 1, value: 4 },
  ]);
  deepEqual(agg.query(end), { count: 2, mean: 2.5, min: 2, max: 3 });
  // A later endpoint slides the window: just-inside-left now sits exactly on
  // the exclusive left edge and drops out, just-past-right enters.
  deepEqual(agg.query(end + 1), { count: 2, mean: 3.5, min: 3, max: 4 });
});

test("many recordIds sharing one timestamp are counted individually", () => {
  const agg = new WindowAggregator();
  const t = 5_000_000;
  agg.upsertBatch([
    { recordId: "a", revision: 0, eventTimeMs: t, value: 10 },
    { recordId: "b", revision: 0, eventTimeMs: t, value: 10 },
    { recordId: "c", revision: 0, eventTimeMs: t, value: 10 },
  ]);
  deepEqual(agg.query(t), { count: 3, mean: 10, min: 10, max: 10 });
});

test("out-of-order and duplicate revisions: only the highest wins", () => {
  const agg = new WindowAggregator();
  agg.upsertBatch([
    { recordId: "r", revision: 5, eventTimeMs: 1000, value: 50 },
    { recordId: "r", revision: 2, eventTimeMs: 2000, value: 999 }, // stale, ignored
    { recordId: "r", revision: 5, eventTimeMs: 1000, value: 50 }, // duplicate, ignored
    { recordId: "r", revision: 4, eventTimeMs: 3000, value: 777 }, // stale, ignored
  ]);
  deepEqual(agg.query(1000), { count: 1, mean: 50, min: 50, max: 50 });
  // Interleaved across batches, higher revision arriving later replaces it.
  agg.upsertBatch([{ recordId: "r", revision: 7, eventTimeMs: 9000, value: 7 }]);
  deepEqual(agg.query(1000), { count: 0, mean: null, min: null, max: null });
  deepEqual(agg.query(9000), { count: 1, mean: 7, min: 7, max: 7 });
  // Stale revision arriving after the replacement is still ignored.
  agg.upsertBatch([{ recordId: "r", revision: 6, eventTimeMs: 1000, value: 50 }]);
  deepEqual(agg.query(9000), { count: 1, mean: 7, min: 7, max: 7 });
});

test("correcting the min/max record migrates its contribution across the boundary", () => {
  const agg = new WindowAggregator();
  const end = 4_000_000;
  agg.upsertBatch([
    { recordId: "lo", revision: 0, eventTimeMs: end - 100, value: -900 },
    { recordId: "hi", revision: 0, eventTimeMs: end - 200, value: 900 },
    { recordId: "mid", revision: 0, eventTimeMs: end - 300, value: 5 },
  ]);
  deepEqual(agg.query(end), { count: 3, mean: 5 / 3, min: -900, max: 900 });

  // Move the min record out of the window and change its value: old min must
  // not linger, and the record must reappear when querying its new endpoint.
  agg.upsertBatch([{ recordId: "lo", revision: 1, eventTimeMs: end + W + 50, value: 42 }]);
  deepEqual(agg.query(end), { count: 2, mean: 905 / 2, min: 5, max: 900 });
  deepEqual(agg.query(end + W + 50), { count: 1, mean: 42, min: 42, max: 42 });

  // Move the max record to a new value below the previous min: old max gone.
  agg.upsertBatch([{ recordId: "hi", revision: 1, eventTimeMs: end - 200, value: -3 }]);
  deepEqual(agg.query(end), { count: 2, mean: 1, min: -3, max: 5 });
});

test("correction can move a record into the window", () => {
  const agg = new WindowAggregator();
  const end = 2_000_000;
  agg.upsertBatch([{ recordId: "x", revision: 0, eventTimeMs: end + 5000, value: 8 }]);
  deepEqual(agg.query(end), { count: 0, mean: null, min: null, max: null });
  agg.upsertBatch([{ recordId: "x", revision: 1, eventTimeMs: end - 1, value: 8 }]);
  deepEqual(agg.query(end), { count: 1, mean: 8, min: 8, max: 8 });
});

test("backfill after a query changes the result for the same endpoint", () => {
  const agg = new WindowAggregator();
  const end = 6_000_000;
  agg.upsertBatch([{ recordId: "a", revision: 0, eventTimeMs: end - 10, value: 2 }]);
  deepEqual(agg.query(end), { count: 1, mean: 2, min: 2, max: 2 });
  agg.upsertBatch([{ recordId: "b", revision: 0, eventTimeMs: end - 20, value: 4 }]);
  deepEqual(agg.query(end), { count: 2, mean: 3, min: 2, max: 4 });
});

test("mean is not rounded to an integer", () => {
  const agg = new WindowAggregator();
  agg.upsertBatch([
    { recordId: "a", revision: 0, eventTimeMs: 100, value: 1 },
    { recordId: "b", revision: 0, eventTimeMs: 100, value: 2 },
  ]);
  deepEqual(agg.query(100), { count: 2, mean: 1.5, min: 1, max: 2 });
});

test("batch larger than 5000 records is rejected", () => {
  const agg = new WindowAggregator();
  const big = Array.from({ length: 5001 }, (_, i) => ({
    recordId: `r${i}`, revision: 0, eventTimeMs: 1, value: 1,
  }));
  let threw = false;
  try {
    agg.upsertBatch(big);
  } catch (e) {
    threw = e instanceof RangeError;
  }
  equal(threw, true);
  equal(agg.size, 0);
});

test("out-of-domain records are rejected", () => {
  const agg = new WindowAggregator();
  const bad = [
    { recordId: "a", revision: -1, eventTimeMs: 1, value: 1 },
    { recordId: "a", revision: 0, eventTimeMs: -1, value: 1 },
    { recordId: "a", revision: 0, eventTimeMs: 1_000_000_000_001, value: 1 },
    { recordId: "a", revision: 0, eventTimeMs: 1, value: 1_000_001 },
    { recordId: "a", revision: 0, eventTimeMs: 1, value: -1_000_001 },
    { recordId: "a", revision: 0, eventTimeMs: 1.5, value: 1 },
  ];
  for (const rec of bad) {
    let threw = false;
    try {
      agg.upsertBatch([rec]);
    } catch (e) {
      threw = e instanceof RangeError;
    }
    equal(threw, true, `expected RangeError for ${JSON.stringify(rec)}`);
  }
  equal(agg.size, 0);
});
