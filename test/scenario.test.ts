import assert from "node:assert/strict";
import { test } from "node:test";
import { analyze, create, resolve, type Pair } from "../src/index.js";

const sortPairs = (ps: readonly Pair[]): Pair[] =>
  [...ps].sort((a, b) =>
    (a.transactionId + a.journalId).localeCompare(b.transactionId + b.journalId),
  );

/**
 * Graph:
 *   T1: J1, J3     T2: J2, J3     T3: J1, J2
 * K = 3. Rulings (T1,J1) and (T2,J2) are endpoint-disjoint and each keeps
 * K = 3 on its own, but together they leave T3/J3 with no candidate edge,
 * so no size-3 matching contains both.
 */
const T = ["T1", "T2", "T3"];
const J = ["J1", "J2", "J3"];
const EDGES: Pair[] = [
  { transactionId: "T1", journalId: "J1" },
  { transactionId: "T1", journalId: "J3" },
  { transactionId: "T2", journalId: "J2" },
  { transactionId: "T2", journalId: "J3" },
  { transactionId: "T3", journalId: "J1" },
  { transactionId: "T3", journalId: "J2" },
];
const R1: Pair = { transactionId: "T1", journalId: "J1" };
const R2: Pair = { transactionId: "T2", journalId: "J2" };

test("individually feasible rulings can be jointly infeasible; rejection is all-or-nothing", () => {
  const session = create(T, J, EDGES);
  const before = analyze(session);
  assert.equal(before.k, 3);
  // Nothing is certain upfront: two size-3 matchings share no edge.
  assert.deepEqual(before.certainPairs, []);
  assert.equal(before.possiblePairs.length, 6);
  assert.deepEqual(before.possiblyUnmatchedTransactionIds, []);
  assert.deepEqual(before.possiblyUnmatchedJournalIds, []);

  // Each ruling alone is acceptable.
  const probe1 = create(T, J, EDGES);
  assert.equal(resolve(probe1, [R1]).accepted, true);
  const probe2 = create(T, J, EDGES);
  assert.equal(resolve(probe2, [R2]).accepted, true);

  // The combined batch must be rejected as a whole.
  const res = resolve(session, [R1, R2]);
  assert.equal(res.accepted, false);
  assert.equal(session.rulings.length, 0);
  const after = analyze(session);
  assert.deepEqual(
    {
      k: after.k,
      certainPairs: sortPairs(after.certainPairs),
      possiblePairs: sortPairs(after.possiblePairs),
      possiblyUnmatchedTransactionIds: after.possiblyUnmatchedTransactionIds,
      possiblyUnmatchedJournalIds: after.possiblyUnmatchedJournalIds,
    },
    {
      k: before.k,
      certainPairs: sortPairs(before.certainPairs),
      possiblePairs: sortPairs(before.possiblePairs),
      possiblyUnmatchedTransactionIds: before.possiblyUnmatchedTransactionIds,
      possiblyUnmatchedJournalIds: before.possiblyUnmatchedJournalIds,
    },
    "analysis must be completely unchanged after a rejected batch",
  );

  // Accepting one feasible ruling cascades: T2->J3 and T3->J2 become certain.
  assert.equal(resolve(session, [R1]).accepted, true);
  const cascaded = analyze(session);
  assert.equal(cascaded.k, 3);
  assert.deepEqual(sortPairs(cascaded.certainPairs), sortPairs([
    { transactionId: "T1", journalId: "J1" },
    { transactionId: "T2", journalId: "J3" },
    { transactionId: "T3", journalId: "J2" },
  ]));
  assert.deepEqual(sortPairs(cascaded.possiblePairs), sortPairs(cascaded.certainPairs));
  assert.deepEqual(cascaded.possiblyUnmatchedTransactionIds, []);
  assert.deepEqual(cascaded.possiblyUnmatchedJournalIds, []);
  // The old ruling is retained.
  assert.deepEqual(session.rulings, [R1]);
});

test("rejects rulings that are not candidate edges or have endpoint conflicts", () => {
  const session = create(T, J, EDGES);
  assert.equal(resolve(session, [{ transactionId: "T1", journalId: "J2" }]).accepted, false);
  assert.equal(
    resolve(session, [
      { transactionId: "T1", journalId: "J1" },
      { transactionId: "T1", journalId: "J3" },
    ]).accepted,
    false,
    "same transaction twice in one batch",
  );
  assert.equal(
    resolve(session, [
      { transactionId: "T1", journalId: "J1" },
      { transactionId: "T3", journalId: "J1" },
    ]).accepted,
    false,
    "same journal twice in one batch",
  );
  assert.equal(session.rulings.length, 0);
  // A ruling conflicting with an already-accepted one is rejected.
  assert.equal(resolve(session, [R1]).accepted, true);
  assert.equal(resolve(session, [{ transactionId: "T3", journalId: "J1" }]).accepted, false);
  assert.equal(session.rulings.length, 1);
});

test("unmatched records on both sides are reported", () => {
  // K = 1: every record can be the one left out on its side... except none
  // side is fully coverable.
  const session = create(["A", "B"], ["X", "Y"], [
    { transactionId: "A", journalId: "X" },
  ]);
  const r = analyze(session);
  assert.equal(r.k, 1);
  assert.deepEqual(r.certainPairs, [{ transactionId: "A", journalId: "X" }]);
  assert.deepEqual(r.possiblePairs, [{ transactionId: "A", journalId: "X" }]);
  assert.deepEqual(r.possiblyUnmatchedTransactionIds, ["B"]);
  assert.deepEqual(r.possiblyUnmatchedJournalIds, ["Y"]);
});

test("create validates inputs and snapshots are immutable", () => {
  assert.throws(() => create(["A", "A"], ["X"], []), /duplicate/);
  assert.throws(() => create(["A"], ["X"], [{ transactionId: "A", journalId: "Z" }]), /unknown/);
  const tIds = ["A"];
  const jIds = ["X"];
  const pairs = [{ transactionId: "A", journalId: "X" }];
  const session = create(tIds, jIds, pairs);
  // Mutating the inputs afterwards must not affect the session.
  tIds.push("B");
  pairs.push({ transactionId: "A", journalId: "Y" } as Pair);
  const r = analyze(session);
  assert.equal(r.k, 1);
  assert.deepEqual(r.possiblePairs, [{ transactionId: "A", journalId: "X" }]);
  // Two sessions over the same data are independent.
  const other = create(["A"], ["X"], [{ transactionId: "A", journalId: "X" }]);
  assert.equal(resolve(session, [{ transactionId: "A", journalId: "X" }]).accepted, true);
  assert.equal(other.rulings.length, 0);
});

test("empty graph yields K = 0 and empty results", () => {
  const session = create([], [], []);
  const r = analyze(session);
  assert.equal(r.k, 0);
  assert.deepEqual(r.certainPairs, []);
  assert.deepEqual(r.possiblePairs, []);
  assert.deepEqual(r.possiblyUnmatchedTransactionIds, []);
  assert.deepEqual(r.possiblyUnmatchedJournalIds, []);
});
