import assert from "node:assert/strict";
import test from "node:test";
import {
  analyze,
  create,
  resolve,
  type AnalysisResult,
  type Pair,
  type Session,
} from "../src/index.js";
import { bruteForceAnalyze, enumerateMatchings, rng } from "./brute-force.js";

function normalize(result: AnalysisResult): AnalysisResult {
  const pairKey = (p: Pair): string => `${p.transactionId}→${p.journalId}`;
  const sortPairs = (pairs: Pair[]): Pair[] =>
    [...pairs].sort((a, b) => pairKey(a).localeCompare(pairKey(b)));
  return {
    k: result.k,
    certainPairs: sortPairs(result.certainPairs),
    possiblePairs: sortPairs(result.possiblePairs),
    possiblyUnmatchedTransactionIds: [
      ...result.possiblyUnmatchedTransactionIds,
    ].sort(),
    possiblyUnmatchedJournalIds: [...result.possiblyUnmatchedJournalIds].sort(),
  };
}

function assertAnalysisEquals(actual: AnalysisResult, expected: AnalysisResult): void {
  assert.deepEqual(normalize(actual), normalize(expected));
}

test("random small graphs match brute-force enumeration, with and without rulings", () => {
  const random = rng(20261005);
  let unmatchedCases = 0;
  for (let iteration = 0; iteration < 300; iteration += 1) {
    const transactionCount = 1 + Math.floor(random() * 4);
    const journalCount = 1 + Math.floor(random() * 4);
    const transactionIds = Array.from(
      { length: transactionCount },
      (_, i) => `T${i}`
    );
    const journalIds = Array.from({ length: journalCount }, (_, i) => `J${i}`);
    const edgeProbability = 0.2 + random() * 0.6;
    const candidatePairs: Pair[] = [];
    for (const t of transactionIds) {
      for (const j of journalIds) {
        if (random() < edgeProbability) {
          candidatePairs.push({ transactionId: t, journalId: j });
        }
      }
    }

    const session = create(transactionIds, journalIds, candidatePairs);
    const expected = bruteForceAnalyze(
      transactionIds,
      journalIds,
      session.candidatePairs as Pair[],
      []
    );
    if (expected.k < Math.min(transactionCount, journalCount)) {
      unmatchedCases += 1;
    }
    assertAnalysisEquals(analyze(session), expected);

    // Apply rulings drawn from a random optimal matching, then re-verify.
    const optimal = enumerateMatchings(session.candidatePairs as Pair[], []).filter(
      (m) => m.length === expected.k
    );
    const chosen = optimal[Math.floor(random() * optimal.length)];
    const rulings = chosen.filter(() => random() < 0.6);
    if (rulings.length === 0) continue;
    const outcome = resolve(session, rulings);
    assert.equal(outcome.accepted, true);
    const expectedAfter = bruteForceAnalyze(
      transactionIds,
      journalIds,
      session.candidatePairs as Pair[],
      rulings
    );
    assertAnalysisEquals(analyze(outcome.session), expectedAfter);
    // Original session must remain unchanged.
    assertAnalysisEquals(analyze(session), expected);
  }
  assert.ok(
    unmatchedCases > 0,
    "expected some random graphs where maximum matching leaves records unmatched"
  );
});

test("random ruling batches: acceptance matches brute-force joint feasibility", () => {
  const random = rng(42);
  for (let iteration = 0; iteration < 200; iteration += 1) {
    const transactionIds = ["T0", "T1", "T2"];
    const journalIds = ["J0", "J1", "J2"];
    const candidatePairs: Pair[] = [];
    for (const t of transactionIds) {
      for (const j of journalIds) {
        if (random() < 0.6) candidatePairs.push({ transactionId: t, journalId: j });
      }
    }
    const session = create(transactionIds, journalIds, candidatePairs);
    const batch = candidatePairs.filter(() => random() < 0.3);
    const outcome = resolve(session, batch);

    const baseline = analyze(session);
    const seen = new Set<string>();
    const deduped = batch.filter((p) => {
      const key = `${p.transactionId}→${p.journalId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const jointlyFeasible = enumerateMatchings(
      session.candidatePairs as Pair[],
      deduped
    ).some((m) => m.length === baseline.k);
    assert.equal(outcome.accepted, jointlyFeasible);
    if (!jointlyFeasible) {
      assert.equal(outcome.session, session);
      assertAnalysisEquals(analyze(outcome.session), baseline);
    }
  }
});

test("individually feasible rulings can be jointly infeasible; batch rejected atomically", () => {
  const transactionIds = ["T1", "T2", "T3"];
  const journalIds = ["J1", "J2", "J3"];
  const candidatePairs: Pair[] = [
    { transactionId: "T1", journalId: "J1" },
    { transactionId: "T1", journalId: "J3" },
    { transactionId: "T2", journalId: "J2" },
    { transactionId: "T2", journalId: "J3" },
    { transactionId: "T3", journalId: "J1" },
    { transactionId: "T3", journalId: "J2" },
  ];
  const session = create(transactionIds, journalIds, candidatePairs);
  const before = analyze(session);
  assert.equal(before.k, 3);
  assert.deepEqual(before.certainPairs, []);
  assert.deepEqual(before.possiblyUnmatchedTransactionIds, []);
  assert.deepEqual(before.possiblyUnmatchedJournalIds, []);

  const rulingA: Pair = { transactionId: "T1", journalId: "J1" };
  const rulingB: Pair = { transactionId: "T2", journalId: "J2" };

  // Each ruling is individually feasible in an optimal solution.
  assert.equal(resolve(session, [rulingA]).accepted, true);
  assert.equal(resolve(session, [rulingB]).accepted, true);

  // Non-conflicting endpoints, yet jointly they cannot keep K=3.
  const combined = resolve(session, [rulingA, rulingB]);
  assert.equal(combined.accepted, false);
  assert.equal(combined.session, session);
  assertAnalysisEquals(analyze(combined.session), before);

  // Accepting one ruling forces a chain reaction on the remaining records.
  const accepted = resolve(session, [rulingA]);
  assert.equal(accepted.accepted, true);
  const after = analyze(accepted.session);
  assert.equal(after.k, 3);
  const sortPairs = (pairs: Pair[]): Pair[] =>
    [...pairs].sort((a, b) =>
      `${a.transactionId}${a.journalId}`.localeCompare(`${b.transactionId}${b.journalId}`)
    );
  assert.deepEqual(sortPairs(after.certainPairs), [
    { transactionId: "T1", journalId: "J1" },
    { transactionId: "T2", journalId: "J3" },
    { transactionId: "T3", journalId: "J2" },
  ]);
  assert.deepEqual(sortPairs(after.possiblePairs), sortPairs(after.certainPairs));

  // The accepted session keeps rulings and supports further analysis rounds.
  const second = resolve(accepted.session, [
    { transactionId: "T2", journalId: "J3" },
  ]);
  assert.equal(second.accepted, true);
  assertAnalysisEquals(analyze(second.session), after);
});

test("create validates input and snapshots are immutable", () => {
  assert.throws(() => create(["T1", "T1"], ["J1"], []), /duplicate transaction/);
  assert.throws(() => create(["T1"], ["J1", "J1"], []), /duplicate journal/);
  assert.throws(
    () => create(["T1"], ["J1"], [{ transactionId: "T9", journalId: "J1" }]),
    /unknown transaction/
  );
  assert.throws(
    () => create(["T1"], ["J1"], [{ transactionId: "T1", journalId: "J9" }]),
    /unknown journal/
  );

  const pairs: Pair[] = [
    { transactionId: "T1", journalId: "J1" },
    { transactionId: "T1", journalId: "J1" },
  ];
  const session = create(["T1"], ["J1"], pairs);
  assert.equal(session.candidatePairs.length, 1);
  pairs.push({ transactionId: "T1", journalId: "J1" });
  assert.equal(session.candidatePairs.length, 1);
  assert.throws(() => {
    (session.candidatePairs as Pair[]).push({ transactionId: "T1", journalId: "J1" });
  }, TypeError);
});

test("resolve rejects non-candidate pairs and conflicting batches", () => {
  const session = create(
    ["T1", "T2"],
    ["J1", "J2"],
    [
      { transactionId: "T1", journalId: "J1" },
      { transactionId: "T2", journalId: "J2" },
    ]
  );
  const nonCandidate = resolve(session, [{ transactionId: "T1", journalId: "J2" }]);
  assert.equal(nonCandidate.accepted, false);
  assert.equal(nonCandidate.session, session);

  const conflicting = resolve(session, [
    { transactionId: "T1", journalId: "J1" },
    { transactionId: "T1", journalId: "J1" },
    { transactionId: "T2", journalId: "J2" },
  ]);
  assert.equal(conflicting.accepted, true, "duplicate identical rulings dedupe");

  const endpointConflict = resolve(session, [
    { transactionId: "T1", journalId: "J1" },
    { transactionId: "T2", journalId: "J1" },
  ]);
  assert.equal(endpointConflict.accepted, false);
});
