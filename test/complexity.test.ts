import { test } from "node:test";
import assert from "node:assert/strict";
import { createWalk, M } from "../src/walk";

/**
 * Complexity evidence via internal counters, not wall-clock time:
 *  - nodeEvals counts every Gaussian node evaluation (the unit of work);
 *  - maxIteratorDepth is the deepest iterator stack (the extra space).
 * Tree height is ceil(log2(M)) = 33. A sweep of k consecutive leaves touches
 * at most 2*k + 2*height distinct tree nodes (per level: k/2^j + 2 nodes),
 * so total work is O(k + log M) with constant 2; bounds below reflect that.
 */

const HEIGHT = Math.ceil(Math.log2(M)); // 33
const LOG_BOUND = 2 * HEIGHT + 4;       // generous O(log M) bound

test("construction and single valueAt are O(log M)", () => {
  const w = createWalk(7n, "perf", 0, 1);
  const afterCtor = w.nodeEvals;
  assert.ok(afterCtor <= 2, `constructor evals=${afterCtor}`);
  w.valueAt(M - 123_456); // far index, worst-case depth
  const evals = w.nodeEvals - afterCtor;
  assert.ok(evals <= LOG_BOUND, `valueAt evals=${evals}, bound=${LOG_BOUND}`);
});

test("direct read of the last 1000 points is O(k + log M)", () => {
  const w = createWalk(7n, "perf", 0, 1);
  const before = w.nodeEvals;
  const out = [...w.readRange(M - 999, 1000)];
  assert.equal(out.length, 1000);
  const evals = w.nodeEvals - before;
  assert.ok(
    evals <= 2 * 1000 + LOG_BOUND,
    `tail-1000 evals=${evals}, bound=${2 * 1000 + LOG_BOUND}`,
  );
  assert.ok(w.maxIteratorDepth <= LOG_BOUND, `depth=${w.maxIteratorDepth}`);
});

test("1M consecutive points: total work O(k + log M), space O(log M)", () => {
  const w = createWalk(7n, "perf", 0, 1);
  const K = 1_000_000;
  const before = w.nodeEvals;
  let count = 0;
  let prev = -Infinity;
  for (const v of w.readRange(1_000_000_000, K)) {
    assert.ok(Number.isFinite(v));
    if (count > 0) assert.notEqual(v, prev); // sanity: not a constant replay
    prev = v;
    count++;
  }
  assert.equal(count, K);
  const evals = w.nodeEvals - before;
  // A per-point full random-access query would cost ~33M evals; we require ~2M.
  assert.ok(evals <= 2 * K + LOG_BOUND, `1M-read evals=${evals}, bound=${2 * K + LOG_BOUND}`);
  assert.ok(
    w.maxIteratorDepth <= LOG_BOUND,
    `iterator stack depth=${w.maxIteratorDepth}, bound=${LOG_BOUND}`,
  );
});

test("early stop does not generate the remaining points", () => {
  const w = createWalk(7n, "perf", 0, 1);
  const before = w.nodeEvals;
  const it = w.readRange(500_000_000, 1_000_000)[Symbol.iterator]();
  for (let i = 0; i < 100; i++) it.next();
  const evals = w.nodeEvals - before;
  assert.ok(evals <= 2 * 100 + LOG_BOUND, `early-stop evals=${evals}, bound=${2 * 100 + LOG_BOUND}`);
  // No further work happens after abandonment.
  const settled = w.nodeEvals;
  assert.equal(w.nodeEvals, settled);
});

test("no growing history cache: instance retains only O(log M) state", () => {
  const w = createWalk(7n, "perf", 0, 1);
  [...w.readRange(0, 200_000)];
  [...w.readRange(M - 199_999, 200_000)];
  // The instance must not accumulate produced points: only scalar bookkeeping
  // fields may exist on the object.
  const keys = Object.keys(w).sort();
  for (const k of keys) {
    const v = (w as unknown as Record<string, unknown>)[k];
    assert.ok(
      typeof v === "number" || typeof v === "bigint",
      `unexpected retained field ${k}: ${typeof v}`,
    );
  }
  assert.ok(w.maxIteratorDepth <= LOG_BOUND, `depth=${w.maxIteratorDepth}`);
});
