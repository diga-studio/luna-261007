import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createJourney,
  applyCompletions,
  visibleState,
  type Journey,
  type StateChange,
  type TaskSpec,
} from "../src/journey.js";

function normalized(diff: StateChange[]): string[] {
  return diff.map((c) => `${c.id}:${c.from}>${c.to}`).sort();
}

function statesOf(journey: Journey, ids: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of ids) {
    out[id] = visibleState(journey, id);
  }
  return out;
}

// Converging graph: a long chain (c1->c2->c3) and a single root (q)
// both feed `join`; `d` hangs off the join point.
const CONVERGING: TaskSpec[] = [
  { id: "c1", prerequisites: [] },
  { id: "c2", prerequisites: ["c1"] },
  { id: "c3", prerequisites: ["c2"] },
  { id: "q", prerequisites: [] },
  { id: "join", prerequisites: ["c3", "q"] },
  { id: "d", prerequisites: ["join"] },
];
const CONVERGING_IDS = CONVERGING.map((t) => t.id);

function setupConverging(): Journey {
  const journey = createJourney(CONVERGING);
  // Complete the long chain; q stays incomplete so the join is locked.
  applyCompletions(journey, { c1: true, c2: true, c3: true });
  // Declarations made while locked: stored but invisible.
  const hidden = applyCompletions(journey, { join: true, d: true });
  assert.deepEqual(hidden, []);
  assert.equal(visibleState(journey, "join"), "locked");
  assert.equal(visibleState(journey, "d"), "locked");
  return journey;
}

test("converging paths: swapping prerequisite states keeps join locked, no spurious diffs", () => {
  const journey = setupConverging();
  const diff = applyCompletions(journey, { c3: false, q: true });
  assert.deepEqual(normalized(diff), ["c3:completed>ready", "q:ready>completed"]);
  assert.deepEqual(statesOf(journey, CONVERGING_IDS), {
    c1: "completed",
    c2: "completed",
    c3: "ready",
    q: "completed",
    join: "locked",
    d: "locked",
  });
});

test("converging paths: batch result is independent of input key order", () => {
  const forward = setupConverging();
  const backward = setupConverging();
  const diffForward = applyCompletions(forward, { c3: false, q: true });
  const diffBackward = applyCompletions(backward, { q: true, c3: false });
  assert.deepEqual(normalized(diffForward), normalized(diffBackward));
  assert.deepEqual(
    statesOf(forward, CONVERGING_IDS),
    statesOf(backward, CONVERGING_IDS)
  );
});

test("converging paths: unblocking restores declarations made while locked", () => {
  const journey = setupConverging();
  applyCompletions(journey, { c3: false, q: true });
  const diff = applyCompletions(journey, { c3: true });
  assert.deepEqual(normalized(diff), [
    "c3:ready>completed",
    "d:locked>completed",
    "join:locked>completed",
  ]);
  assert.deepEqual(statesOf(journey, CONVERGING_IDS), {
    c1: "completed",
    c2: "completed",
    c3: "completed",
    q: "completed",
    join: "completed",
    d: "completed",
  });
});

const CHAIN_LENGTH = 6;
const CHAIN: TaskSpec[] = Array.from({ length: CHAIN_LENGTH }, (_, i) => ({
  id: `t${i + 1}`,
  prerequisites: i === 0 ? [] : [`t${i}`],
}));
const CHAIN_IDS = CHAIN.map((t) => t.id);

test("long chain: reverse-ordered batch completes everything at once", () => {
  const journey = createJourney(CHAIN);
  const reversed: Record<string, boolean> = {};
  for (const id of [...CHAIN_IDS].reverse()) {
    reversed[id] = true;
  }
  const diff = applyCompletions(journey, reversed);
  assert.deepEqual(normalized(diff), [
    "t1:ready>completed",
    "t2:locked>completed",
    "t3:locked>completed",
    "t4:locked>completed",
    "t5:locked>completed",
    "t6:locked>completed",
  ]);
  for (const id of CHAIN_IDS) {
    assert.equal(visibleState(journey, id), "completed");
  }
});

test("long chain: undo near head re-locks descendants, restore recovers them", () => {
  const journey = createJourney(CHAIN);
  applyCompletions(journey, Object.fromEntries(CHAIN_IDS.map((id) => [id, true])));

  const undoDiff = applyCompletions(journey, { t2: false });
  assert.deepEqual(normalized(undoDiff), [
    "t2:completed>ready",
    "t3:completed>locked",
    "t4:completed>locked",
    "t5:completed>locked",
    "t6:completed>locked",
  ]);
  assert.equal(visibleState(journey, "t1"), "completed");

  const restoreDiff = applyCompletions(journey, { t2: true });
  assert.deepEqual(normalized(restoreDiff), [
    "t2:ready>completed",
    "t3:locked>completed",
    "t4:locked>completed",
    "t5:locked>completed",
    "t6:locked>completed",
  ]);
  for (const id of CHAIN_IDS) {
    assert.equal(visibleState(journey, id), "completed");
  }
});

test("reapplying the same assignments produces no diffs", () => {
  const journey = createJourney(CHAIN);
  applyCompletions(journey, { t1: true, t2: true });
  const again = applyCompletions(journey, { t2: true, t1: true });
  assert.deepEqual(again, []);
});

test("validation: duplicate ids, unknown prerequisites, unknown change targets", () => {
  assert.throws(() =>
    createJourney([
      { id: "a", prerequisites: [] },
      { id: "a", prerequisites: [] },
    ])
  );
  assert.throws(() =>
    createJourney([{ id: "a", prerequisites: ["missing"] }])
  );
  const journey = createJourney([{ id: "a", prerequisites: [] }]);
  assert.throws(() => applyCompletions(journey, { ghost: true }));
});
