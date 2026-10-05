import { test } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { analyzeJourney, compileJourney, explainAttempt } from "../src/index";
import type { JourneyEvent } from "../src/index";

const MINUTE = 60 * 1000;

test("delayed candidate, 30-minute boundary and out-of-range completion", () => {
  const events: JourneyEvent[] = [
    { eventId: 1, customerId: "c1", eventType: "A", timestamp: 0 },
    { eventId: 2, customerId: "c1", eventType: "B", timestamp: 1 * MINUTE },
    { eventId: 3, customerId: "c1", eventType: "B", timestamp: 20 * MINUTE },
    { eventId: 4, customerId: "c1", eventType: "C", timestamp: 50 * MINUTE },
  ];
  const compiled = compileJourney({
    stages: [{ eventType: "A" }, { eventType: "B" }, { eventType: "C" }],
  });
  const result = analyzeJourney(compiled, events, { start: 0, end: 1 });
  assert.equal(result.entryCount, 1);
  assert.deepEqual(result.stats.arrivals, [1, 1, 1]);
  assert.deepEqual(result.stats.conversionRates, [1, 1]);
  assert.deepEqual(result.stats.transitionMedianMs, [20 * MINUTE, 30 * MINUTE]);
  assert.deepEqual(explainAttempt(result, 1), [1, 3, 4]);
  assert.equal(explainAttempt(result, 2), null);
});

test("shared events and same-timestamp ordering by eventId", () => {
  const events: JourneyEvent[] = [];
  for (let i = 1; i <= 5; i++) {
    events.push({ eventId: i, customerId: "c1", eventType: "T", timestamp: 1000 });
  }
  const compiled = compileJourney({
    stages: [
      { eventType: "T", count: 1 },
      { eventType: "T", count: 2 },
      { eventType: "T", count: 1 },
    ],
  });
  const result = analyzeJourney(compiled, events, { start: 0, end: 2000 });
  assert.equal(result.entryCount, 5);
  assert.deepEqual(result.stats.arrivals, [5, 3, 2]);
  assert.deepEqual(explainAttempt(result, 1), [1, 3, 4]);
  assert.deepEqual(explainAttempt(result, 2), [2, 4, 5]);
  assert.deepEqual(explainAttempt(result, 3), [3, 5]);
  assert.deepEqual(explainAttempt(result, 4), [4]);
  assert.deepEqual(explainAttempt(result, 5), [5]);
});

test("scale: 200k events, 20 stages, analysis within 30 seconds", () => {
  const total = 200000;
  const events: JourneyEvent[] = [];
  for (let i = 0; i < total - 1; i++) {
    events.push({ eventId: i + 1, customerId: "c1", eventType: "X", timestamp: i });
  }
  events.push({ eventId: total, customerId: "c1", eventType: "Y", timestamp: total - 1 });

  const stages = [{ eventType: "X", count: 1 }];
  for (let s = 1; s <= 18; s++) stages.push({ eventType: "X", count: 3 });
  stages.push({ eventType: "Y", count: 1 });
  const compiled = compileJourney({ stages });

  const started = performance.now();
  const result = analyzeJourney(compiled, events, { start: 0, end: total });
  const elapsedMs = performance.now() - started;
  assert.ok(elapsedMs < 30000, `analysis took ${elapsedMs}ms`);

  const expectedArrivals: number[] = [];
  for (let s = 0; s < 20; s++) {
    if (s === 0) expectedArrivals.push(total - 1);
    else if (s <= 18) expectedArrivals.push(total - 1 - 3 * s);
    else expectedArrivals.push(total - 1 - 3 * 18);
  }
  assert.deepEqual(result.stats.arrivals, expectedArrivals);

  const expectedMedians: number[] = [];
  for (let s = 0; s < 19; s++) {
    if (s < 18) expectedMedians.push(3);
    else expectedMedians.push(99973);
  }
  assert.deepEqual(result.stats.transitionMedianMs, expectedMedians);

  for (let s = 0; s < 19; s++) {
    const rate = result.stats.conversionRates[s];
    assert.ok(rate !== null);
    assert.ok(Math.abs(rate - expectedArrivals[s + 1] / expectedArrivals[s]) < 1e-12);
  }

  const firstPath = explainAttempt(result, 1);
  assert.ok(firstPath !== null);
  const expectedFirstPath: number[] = [1];
  for (let s = 1; s <= 18; s++) expectedFirstPath.push(3 * s + 1);
  expectedFirstPath.push(total);
  assert.deepEqual(firstPath, expectedFirstPath);
});

test("property equality conditions use exact scalar matching", () => {
  const events: JourneyEvent[] = [
    { eventId: 1, customerId: "c1", eventType: "A", timestamp: 0 },
    { eventId: 2, customerId: "c1", eventType: "B", timestamp: 10, properties: { plan: "free" } },
    { eventId: 3, customerId: "c1", eventType: "B", timestamp: 20, properties: { plan: "pro" } },
    { eventId: 4, customerId: "c1", eventType: "B", timestamp: 30 },
  ];
  const compiled = compileJourney({
    stages: [{ eventType: "A" }, { eventType: "B", properties: { plan: "pro" } }],
  });
  const result = analyzeJourney(compiled, events, { start: 0, end: 5 });
  assert.deepEqual(result.stats.arrivals, [1, 1]);
  assert.deepEqual(explainAttempt(result, 1), [1, 3]);
});

test("paths never cross customers and entries are counted per attempt", () => {
  const events: JourneyEvent[] = [
    { eventId: 1, customerId: "c1", eventType: "A", timestamp: 0 },
    { eventId: 2, customerId: "c2", eventType: "A", timestamp: 0 },
    { eventId: 3, customerId: "c2", eventType: "B", timestamp: 10 },
    { eventId: 4, customerId: "c1", eventType: "B", timestamp: 20 },
  ];
  const compiled = compileJourney({
    stages: [{ eventType: "A" }, { eventType: "B" }],
  });
  const result = analyzeJourney(compiled, events, { start: 0, end: 5 });
  assert.deepEqual(result.stats.arrivals, [2, 2]);
  assert.deepEqual(explainAttempt(result, 1), [1, 4]);
  assert.deepEqual(explainAttempt(result, 2), [2, 3]);
});

test("compileJourney validates stage count and count bounds", () => {
  assert.throws(() => compileJourney({ stages: [] }), /at least one stage/);
  assert.throws(
    () =>
      compileJourney({
        stages: Array.from({ length: 21 }, () => ({ eventType: "A" })),
      }),
    /at most 20 stages/,
  );
  assert.throws(
    () => compileJourney({ stages: [{ eventType: "A", count: 2 }] }),
    /first stage/,
  );
  assert.throws(
    () => compileJourney({ stages: [{ eventType: "A" }, { eventType: "B", count: 4 }] }),
    /between 1 and 3/,
  );
  assert.throws(
    () =>
      compileJourney({
        stages: [{ eventType: "A", properties: { bad: null as unknown as string } }],
      }),
    /scalar/,
  );
});
