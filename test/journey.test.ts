import { test } from "node:test";
import { deepEqual } from "node:assert/strict";
import {
  applyCompletions,
  createJourney,
  type StateChange,
} from "../src/journey.js";

function sorted(changes: StateChange[]): StateChange[] {
  return [...changes].sort((a, b) => a.id.localeCompare(b.id));
}

test("converging paths: swapping prerequisites keeps join locked, no spurious diffs, declarations survive", () => {
  // Paths of different lengths converge at "join":
  //   x -> s1 -----------+
  //   y -> t1 -> t2 -----+--> join --> child
  const journey = createJourney([
    { id: "x", prerequisites: [] },
    { id: "y", prerequisites: [] },
    { id: "s1", prerequisites: ["x"] },
    { id: "t1", prerequisites: ["y"] },
    { id: "t2", prerequisites: ["t1"] },
    { id: "join", prerequisites: ["s1", "t2"] },
    { id: "child", prerequisites: ["join"] },
  ]);

  // Complete everything except t2 and join; declare child while locked.
  const setup = applyCompletions(journey, {
    x: true,
    y: true,
    s1: true,
    t1: true,
    child: true,
  });
  deepEqual(sorted(setup), [
    { id: "s1", from: "locked", to: "completed" },
    { id: "t1", from: "locked", to: "completed" },
    { id: "t2", from: "locked", to: "ready" },
    { id: "x", from: "ready", to: "completed" },
    { id: "y", from: "ready", to: "completed" },
  ]);

  // Swap completion between the two branches feeding the join.
  const swap = applyCompletions(journey, { s1: false, t2: true });
  deepEqual(sorted(swap), [
    { id: "s1", from: "completed", to: "ready" },
    { id: "t2", from: "ready", to: "completed" },
  ]);

  // Same assignments, reversed input order: identical result.
  const journey2 = createJourney([
    { id: "x", prerequisites: [] },
    { id: "y", prerequisites: [] },
    { id: "s1", prerequisites: ["x"] },
    { id: "t1", prerequisites: ["y"] },
    { id: "t2", prerequisites: ["t1"] },
    { id: "join", prerequisites: ["s1", "t2"] },
    { id: "child", prerequisites: ["join"] },
  ]);
  applyCompletions(journey2, { x: true, y: true, s1: true, t1: true, child: true });
  const swapReversed = applyCompletions(journey2, { t2: true, s1: false });
  deepEqual(swapReversed, swap);

  // Re-submitting the same assignments yields no diffs.
  deepEqual(applyCompletions(journey, { t2: true, s1: false }), []);

  // Unblock s1: join becomes ready; child stays locked (join not yet declared).
  deepEqual(applyCompletions(journey, { s1: true }), [
    { id: "s1", from: "ready", to: "completed" },
    { id: "join", from: "locked", to: "ready" },
  ]);

  // Complete join: child's retained declaration restores it automatically.
  deepEqual(applyCompletions(journey, { join: true }), [
    { id: "join", from: "ready", to: "completed" },
    { id: "child", from: "locked", to: "completed" },
  ]);
});

test("long chain: reverse-order batch completion, undo and restore near the head", () => {
  const length = 8;
  const tasks = Array.from({ length }, (_, i) => ({
    id: `c${i}`,
    prerequisites: i === 0 ? [] : [`c${i - 1}`],
  }));
  const journey = createJourney(tasks);

  // Declare everything complete in a single batch, keys in reverse chain order.
  const allTrue: Record<string, boolean> = {};
  for (let i = length - 1; i >= 0; i--) {
    allTrue[`c${i}`] = true;
  }
  const completed = applyCompletions(journey, allTrue);
  deepEqual(
    sorted(completed),
    tasks.map((t, i) => ({
      id: t.id,
      from: i === 0 ? "ready" : "locked",
      to: "completed",
    }))
  );

  // Undo a task near the head: it becomes ready, everything downstream locks.
  const undone = applyCompletions(journey, { c1: false });
  deepEqual(sorted(undone), [
    { id: "c1", from: "completed", to: "ready" },
    ...Array.from({ length: length - 2 }, (_, i) => ({
      id: `c${i + 2}`,
      from: "completed",
      to: "locked",
    })),
  ]);

  // Restore it: retained declarations make the whole chain complete again.
  const restored = applyCompletions(journey, { c1: true });
  deepEqual(sorted(restored), [
    { id: "c1", from: "ready", to: "completed" },
    ...Array.from({ length: length - 2 }, (_, i) => ({
      id: `c${i + 2}`,
      from: "locked",
      to: "completed",
    })),
  ]);

  // Repeating the same assignment produces no further diffs.
  deepEqual(applyCompletions(journey, { c1: true }), []);
});
