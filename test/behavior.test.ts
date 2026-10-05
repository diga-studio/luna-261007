import { test } from "node:test";
import assert from "node:assert/strict";
import {
  analyzeJourney,
  compileJourney,
  explainAttempt,
} from "../src/index";
import type { JourneyEvent } from "../src/index";

const MIN = 60_000;

test("compileJourney validates definitions", () => {
  assert.throws(() => compileJourney([]), /at least 1/);
  assert.throws(
    () => compileJourney(Array.from({ length: 21 }, () => ({ eventType: "A" }))),
    /at most 20/,
  );
  assert.throws(
    () => compileJourney([{ eventType: "A", count: 2 }]),
    /stage 1.*count must be 1/,
  );
  assert.throws(
    () => compileJourney([{ eventType: "A" }, { eventType: "B", count: 0 }]),
    /between 1 and 3/,
  );
  assert.throws(
    () => compileJourney([{ eventType: "A" }, { eventType: "B", count: 4 }]),
    /between 1 and 3/,
  );
  assert.throws(
    () =>
      compileJourney([
        { eventType: "A", properties: { nested: { bad: true } as never } },
      ]),
    /scalar/,
  );
  // Object form and defaults are accepted.
  const compiled = compileJourney({ stages: [{ eventType: "A" }, { eventType: "B" }] });
  assert.equal(compiled.stages.length, 2);
  assert.equal(compiled.stages[1]!.count, 1);
});

test("property equality conditions filter matches", () => {
  const events: JourneyEvent[] = [
    { eventId: 1, customerId: "c1", eventType: "A", timestamp: 0 },
    { eventId: 2, customerId: "c1", eventType: "B", timestamp: MIN, properties: { plan: "free" } },
    { eventId: 3, customerId: "c1", eventType: "B", timestamp: 2 * MIN, properties: { plan: "pro" } },
  ];
  const compiled = compileJourney([
    { eventType: "A" },
    { eventType: "B", properties: { plan: "pro" } },
  ]);
  const result = analyzeJourney(compiled, [events], {
    startInclusive: 0,
    endExclusive: MIN,
  });
  assert.deepEqual(explainAttempt(result, 1), [1, 3]);
});

test("paths never cross customers", () => {
  const c1: JourneyEvent[] = [
    { eventId: 1, customerId: "c1", eventType: "A", timestamp: 0 },
  ];
  const c2: JourneyEvent[] = [
    { eventId: 2, customerId: "c2", eventType: "B", timestamp: MIN },
  ];
  const compiled = compileJourney([{ eventType: "A" }, { eventType: "B" }]);
  const result = analyzeJourney(compiled, [c1, c2], {
    startInclusive: 0,
    endExclusive: MIN,
  });
  assert.deepEqual(
    result.stages.map((s) => s.arrivals),
    [1, 0],
  );
});

test("only entries inside the range produce attempts", () => {
  const events: JourneyEvent[] = [
    { eventId: 1, customerId: "c1", eventType: "A", timestamp: 0 },
    { eventId: 2, customerId: "c1", eventType: "A", timestamp: 100 * MIN },
  ];
  const compiled = compileJourney([{ eventType: "A" }]);
  const result = analyzeJourney(compiled, [events], {
    startInclusive: 0,
    endExclusive: 10 * MIN,
  });
  assert.equal(result.totalAttempts, 1);
  assert.deepEqual(explainAttempt(result, 1), [1]);
  assert.throws(() => explainAttempt(result, 2), /not an entry/);
});

test("ties resolve to the lexicographically earliest completions", () => {
  // Both B@10min and B@15min reach C@40min within 30 minutes; the path
  // through the earlier completion event wins.
  const events: JourneyEvent[] = [
    { eventId: 1, customerId: "c1", eventType: "A", timestamp: 0 },
    { eventId: 2, customerId: "c1", eventType: "B", timestamp: 10 * MIN },
    { eventId: 3, customerId: "c1", eventType: "B", timestamp: 15 * MIN },
    { eventId: 4, customerId: "c1", eventType: "C", timestamp: 40 * MIN },
  ];
  const compiled = compileJourney([
    { eventType: "A" },
    { eventType: "B" },
    { eventType: "C" },
  ]);
  const result = analyzeJourney(compiled, [events], {
    startInclusive: 0,
    endExclusive: MIN,
  });
  assert.deepEqual(explainAttempt(result, 1), [1, 2, 4]);
});
