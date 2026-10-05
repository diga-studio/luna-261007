import { test } from "node:test";
import assert from "node:assert/strict";
import {
  analyzeJourney,
  compileJourney,
  explainAttempt,
} from "../src/index";
import type { JourneyEvent } from "../src/index";

const MIN = 60_000;

test("delayed candidate, 30-minute boundary and out-of-range completion", () => {
  // A at minute 0, B at minutes 1 and 20, C at minute 50.
  // Only B@20min reaches C@50min (exactly 30 minutes, inclusive boundary);
  // the greedy-earliest B@1min would leave C 49 minutes away and unreachable.
  const events: JourneyEvent[] = [
    { eventId: 1, customerId: "c1", eventType: "A", timestamp: 0 },
    { eventId: 2, customerId: "c1", eventType: "B", timestamp: 1 * MIN },
    { eventId: 3, customerId: "c1", eventType: "B", timestamp: 20 * MIN },
    { eventId: 4, customerId: "c1", eventType: "C", timestamp: 50 * MIN },
  ];
  const compiled = compileJourney([
    { eventType: "A" },
    { eventType: "B" },
    { eventType: "C" },
  ]);
  // Entry range covers only A; completions outside the range are allowed.
  const result = analyzeJourney(compiled, [events], {
    startInclusive: 0,
    endExclusive: 10 * MIN,
  });

  assert.equal(result.totalAttempts, 1);
  assert.deepEqual(
    result.stages.map((s) => s.arrivals),
    [1, 1, 1],
  );
  assert.deepEqual(explainAttempt(result, 1), [1, 3, 4]);
  assert.deepEqual(
    result.stages.map((s) => s.medianTransitionMs),
    [null, 20 * MIN, 30 * MIN],
  );
  assert.deepEqual(
    result.stages.map((s) => s.conversionFromPrevious),
    [null, 1, 1],
  );
});

test("same-timestamp events: shared usage, eventId order, counts 1/2/1", () => {
  // Five events with identical timestamp and type; every stage matches.
  // Entries form in eventId order; events are shared across attempts.
  const events: JourneyEvent[] = [1, 2, 3, 4, 5].map((id) => ({
    eventId: id,
    customerId: "c1",
    eventType: "E",
    timestamp: 1000,
  }));
  const compiled = compileJourney([
    { eventType: "E", count: 1 },
    { eventType: "E", count: 2 },
    { eventType: "E", count: 1 },
  ]);
  const result = analyzeJourney(compiled, [events], {
    startInclusive: 0,
    endExclusive: 2000,
  });

  assert.equal(result.totalAttempts, 5);
  assert.deepEqual(
    result.stages.map((s) => s.arrivals),
    [5, 3, 2],
  );
  assert.deepEqual(explainAttempt(result, 1), [1, 3, 4]);
  assert.deepEqual(explainAttempt(result, 2), [2, 4, 5]);
  assert.deepEqual(explainAttempt(result, 3), [3, 5]);
  assert.deepEqual(explainAttempt(result, 4), [4]);
  assert.deepEqual(explainAttempt(result, 5), [5]);
  // All completions share the same timestamp, so transitions are 0ms.
  assert.deepEqual(
    result.stages.map((s) => s.medianTransitionMs),
    [null, 0, 0],
  );
});

test("scale: 200k events, 20 stages, under 30 seconds", () => {
  // 199999 X events then a single Y, one customer, timestamps 1ms apart.
  // Stages 1..19 match X (stage 1 count 1, stages 2..19 count 3),
  // stage 20 matches Y (count 1).
  const TOTAL = 200_000;
  const events: JourneyEvent[] = [];
  for (let i = 0; i < TOTAL - 1; i++) {
    events.push({
      eventId: i + 1,
      customerId: "c1",
      eventType: "X",
      timestamp: i,
    });
  }
  events.push({
    eventId: TOTAL,
    customerId: "c1",
    eventType: "Y",
    timestamp: TOTAL - 1,
  });

  const stages = [
    { eventType: "X", count: 1 },
    ...Array.from({ length: 18 }, () => ({ eventType: "X", count: 3 })),
    { eventType: "Y", count: 1 },
  ];
  const compiled = compileJourney(stages);

  // Timing covers analysis only, not input generation.
  const started = performance.now();
  const result = analyzeJourney(compiled, [events], {
    startInclusive: 0,
    endExclusive: TOTAL,
  });
  const elapsedMs = performance.now() - started;
  assert.ok(
    elapsedMs < 30_000,
    `analysis took ${elapsedMs.toFixed(0)}ms, expected under 30000ms`,
  );

  // Entry i (0-based) completes stage k (1-based, k<=19) at event index
  // i + 3*(k-1); it must be an X, i.e. <= 199998. Stage 20 is the final Y,
  // always within 30 minutes of any stage-19 completion.
  const expectedArrivals = Array.from({ length: 20 }, (_, idx) => {
    const k = idx + 1;
    if (k === 1) return TOTAL - 1;
    if (k <= 19) return TOTAL - 1 - 3 * (k - 1);
    return TOTAL - 1 - 3 * 18;
  });
  assert.deepEqual(
    result.stages.map((s) => s.arrivals),
    expectedArrivals,
  );
  assert.equal(result.totalAttempts, TOTAL - 1);

  // Transitions between X stages take 3ms (three matches 1ms apart).
  // The final transition to Y takes 199999-(i+54) ms for entry i, i.e. the
  // values 1..199945, whose median is 99973.
  const expectedMedians = Array.from({ length: 20 }, (_, idx) => {
    if (idx === 0) return null;
    if (idx <= 18) return 3;
    return 99973;
  });
  assert.deepEqual(
    result.stages.map((s) => s.medianTransitionMs),
    expectedMedians,
  );

  // Spot-check selected paths of the first and the last full entry.
  const firstPath = explainAttempt(result, 1);
  assert.equal(firstPath.length, 20);
  assert.deepEqual(firstPath.slice(0, 4), [1, 4, 7, 10]);
  assert.equal(firstPath[18], 55);
  assert.equal(firstPath[19], TOTAL);
  const lastFullPath = explainAttempt(result, 199_945);
  assert.equal(lastFullPath.length, 20);
  assert.equal(lastFullPath[18], 199_999);
  assert.equal(lastFullPath[19], TOTAL);
});
