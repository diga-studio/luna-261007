import { test } from "node:test";
import { deepEqual, equal } from "node:assert/strict";
import { WindowAggregator, WINDOW_MS, InputRecord, WindowStats } from "../src/aggregator";

function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const N = 500_000;
const MONO = 400_000; // records r0..r399999 with t = i (monotonic timestamps)
const SHARED_T = 250_000; // records r400000..r499999 all share this timestamp
const FULL_END = 1_000_000; // window (FULL_END-WINDOW_MS, FULL_END] covers every record
const EMPTY_END = 10_000_000; // window starts past every record
const RESERVED_LO = 300_000; // corrections only touch r300000..r309999,
const RESERVED_HI = 309_999; // whose values always stay within [1, 998]

function initialRecord(i: number): InputRecord {
  if (i < MONO) {
    return { recordId: `r${i}`, revision: 0, eventTimeMs: i, value: i % 1000 };
  }
  return { recordId: `r${i}`, revision: 0, eventTimeMs: SHARED_T, value: (i % 998) + 1 };
}

test("500k records, 100k queries, 50k interleaved with small correction batches", { timeout: 120_000 }, () => {
  const rand = makeRng(0xC0FFEE);
  const agg = new WindowAggregator();

  // Mirror of the aggregator's live state, used to derive expectations.
  const t = new Array<number>(N);
  const v = new Array<number>(N);
  const rev = new Array<number>(N);

  // --- Load 500k distinct recordIds in 100 batches of 5000. ---
  for (let b = 0; b < N / 5000; b++) {
    const batch: InputRecord[] = [];
    for (let i = b * 5000; i < (b + 1) * 5000; i++) {
      const rec = initialRecord(i);
      batch.push(rec);
      t[i] = rec.eventTimeMs;
      v[i] = rec.value;
      rev[i] = 0;
    }
    agg.upsertBatch(batch);
  }
  equal(agg.size, N);

  // Incrementally maintained expectation for the full-coverage endpoint.
  let expCount = 0;
  let expSum = 0;
  for (let i = 0; i < N; i++) {
    expCount += 1;
    expSum += v[i]!;
  }
  // Values 0 and 999 occur only outside the reserved range, hundreds of
  // times each, so corrections inside the reserved range (values kept in
  // [1, 998]) can never disturb the global extremes.
  const EXP_MIN = 0;
  const EXP_MAX = 999;

  const expectFull = (): WindowStats => ({
    count: expCount,
    mean: expCount === 0 ? null : expSum / expCount,
    min: expCount === 0 ? null : EXP_MIN,
    max: expCount === 0 ? null : EXP_MAX,
  });

  const inFullWindow = (time: number) =>
    time > FULL_END - WINDOW_MS && time <= FULL_END;

  // Naive cross-check for arbitrary endpoints, used on a sample of queries.
  const naiveQuery = (endMs: number): WindowStats => {
    const lo = endMs - WINDOW_MS;
    let count = 0;
    let sum = 0;
    let min: number | null = null;
    let max: number | null = null;
    for (let i = 0; i < N; i++) {
      const ti = t[i]!;
      if (ti <= lo || ti > endMs) continue;
      const vi = v[i]!;
      count += 1;
      sum += vi;
      if (min === null || vi < min) min = vi;
      if (max === null || vi > max) max = vi;
    }
    return count === 0
      ? { count: 0, mean: null, min: null, max: null }
      : { count, mean: sum / count, min, max };
  };

  // --- Phase 1: 25k queries over the full dataset before any correction. ---
  for (let q = 0; q < 25_000; q++) {
    deepEqual(agg.query(FULL_END), expectFull());
  }

  // --- Phase 2: 5k iterations of (batch of 10 corrections + 10 queries). ---
  // Corrections rewrite a reserved record's time and value, sometimes moving
  // it out of the full-coverage window and later back in.
  for (let it = 0; it < 5_000; it++) {
    const batch: InputRecord[] = [];
    for (let k = 0; k < 10; k++) {
      const i = RESERVED_LO + Math.floor(rand() * (RESERVED_HI - RESERVED_LO + 1));
      rev[i] = rev[i]! + 1;
      const moveOut = rand() < 0.3;
      const newT = moveOut
        ? FULL_END + 1 + Math.floor(rand() * 1000)
        : Math.floor(rand() * (MONO + 1)); // lands inside the covered range
      const newV = 1 + Math.floor(rand() * 998);
      if (inFullWindow(t[i]!)) {
        expCount -= 1;
        expSum -= v[i]!;
      }
      if (inFullWindow(newT)) {
        expCount += 1;
        expSum += newV;
      }
      t[i] = newT;
      v[i] = newV;
      batch.push({ recordId: `r${i}`, revision: rev[i]!, eventTimeMs: newT, value: newV });
    }
    agg.upsertBatch(batch);
    for (let q = 0; q < 10; q++) {
      deepEqual(agg.query(FULL_END), expectFull());
    }
    // Occasional duplicate / stale deliveries must not change anything.
    if (it % 100 === 0) {
      const i = RESERVED_LO + (it % (RESERVED_HI - RESERVED_LO + 1));
      const junk: InputRecord[] = [
        { recordId: `r${i}`, revision: rev[i]!, eventTimeMs: t[i]!, value: v[i]! },
      ];
      if (rev[i]! >= 1) {
        junk.push({ recordId: `r${i}`, revision: rev[i]! - 1, eventTimeMs: 0, value: 0 });
      }
      agg.upsertBatch(junk);
      deepEqual(agg.query(FULL_END), expectFull());
    }
  }

  // --- Phase 3: 25k more queries at derivable endpoints. ---
  // r0 (t=0, value=0) is never corrected, so the t=0 window is stable.
  for (let q = 0; q < 24_000; q++) {
    const pick = q % 3;
    if (pick === 0) {
      deepEqual(agg.query(FULL_END), expectFull());
    } else if (pick === 1) {
      deepEqual(agg.query(EMPTY_END), { count: 0, mean: null, min: null, max: null });
    } else {
      deepEqual(agg.query(0), { count: 1, mean: 0, min: 0, max: 0 });
    }
  }
  // Sampled naive cross-checks at arbitrary jumping endpoints.
  for (let s = 0; s < 1_000; s++) {
    const endMs = Math.floor(rand() * (FULL_END + 500_000));
    deepEqual(agg.query(endMs), naiveQuery(endMs), `naive cross-check query(${endMs})`);
  }

  equal(agg.size, N);
});
