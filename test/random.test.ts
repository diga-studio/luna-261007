import assert from "node:assert/strict";
import { test } from "node:test";
import { analyze, create, resolve, type AnalysisResult, type Pair } from "../src/index.js";
import { bruteForceAnalyze, bruteForceFeasible } from "./bruteForce.js";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sortPairs = (ps: readonly Pair[]): Pair[] =>
  [...ps].sort((a, b) =>
    (a.transactionId + a.journalId).localeCompare(b.transactionId + b.journalId),
  );

function normalized(r: AnalysisResult) {
  return {
    k: r.k,
    certainPairs: sortPairs(r.certainPairs),
    possiblePairs: sortPairs(r.possiblePairs),
    possiblyUnmatchedTransactionIds: [...r.possiblyUnmatchedTransactionIds].sort(),
    possiblyUnmatchedJournalIds: [...r.possiblyUnmatchedJournalIds].sort(),
  };
}

function assertAnalysisMatches(
  actual: AnalysisResult,
  expected: AnalysisResult,
  context: string,
): void {
  assert.deepEqual(normalized(actual), normalized(expected), context);
}

test("random small graphs match brute-force enumeration, with and without rulings", () => {
  let sawUnmatched = 0;
  let sawRulingRounds = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const rand = mulberry32(seed);
    const nT = 1 + Math.floor(rand() * 6); // 1..6
    const nJ = 1 + Math.floor(rand() * 6); // 1..6
    const tIds = Array.from({ length: nT }, (_, i) => `T${i}`);
    const jIds = Array.from({ length: nJ }, (_, i) => `J${i}`);
    const density = 0.2 + rand() * 0.6;
    const candidates: Pair[] = [];
    for (const t of tIds) {
      for (const j of jIds) {
        if (rand() < density) candidates.push({ transactionId: t, journalId: j });
      }
    }
    // Duplicate candidate pairs must not change anything.
    const withDupes = [...candidates, ...candidates.filter(() => rand() < 0.3)];

    const session = create(tIds, jIds, withDupes);
    const expected0 = bruteForceAnalyze(tIds, jIds, candidates, []);
    assertAnalysisMatches(analyze(session), expected0, `seed=${seed} initial`);
    if (expected0.possiblyUnmatchedTransactionIds.length > 0 || expected0.possiblyUnmatchedJournalIds.length > 0) {
      sawUnmatched++;
    }

    // Apply a few rounds of rulings that brute force deems jointly feasible.
    const accepted: Pair[] = [];
    for (let round = 0; round < 3; round++) {
      const possible = analyze(session).possiblePairs;
      const pool = possible.filter(
        (p) => !accepted.some((a) => a.transactionId === p.transactionId && a.journalId === p.journalId),
      );
      if (pool.length === 0) break;
      const pick = pool[Math.floor(rand() * pool.length)]!;
      const batch = [...accepted, pick];
      if (!bruteForceFeasible(tIds, jIds, candidates, batch)) continue;
      const res = resolve(session, [pick]);
      assert.equal(res.accepted, true, `seed=${seed} round=${round} must accept feasible ruling`);
      accepted.push(pick);
      const expected = bruteForceAnalyze(tIds, jIds, candidates, accepted);
      assertAnalysisMatches(analyze(session), expected, `seed=${seed} round=${round}`);
      // Old rulings stay certain after re-analysis.
      for (const a of accepted) {
        assert.ok(
          analyze(session).certainPairs.some(
            (c) => c.transactionId === a.transactionId && c.journalId === a.journalId,
          ),
          `seed=${seed}: accepted ruling must remain certain`,
        );
      }
      sawRulingRounds++;
    }
  }
  assert.ok(sawUnmatched > 0, "expected some random graphs where K cannot cover every record");
  assert.ok(sawRulingRounds > 0, "expected some feasible ruling rounds to exercise resolve");
});

test("random infeasible ruling batches are rejected and leave the session unchanged", () => {
  let sawRejection = 0;
  for (let seed = 1000; seed < 1150; seed++) {
    const rand = mulberry32(seed);
    const nT = 2 + Math.floor(rand() * 5);
    const nJ = 2 + Math.floor(rand() * 5);
    const tIds = Array.from({ length: nT }, (_, i) => `T${i}`);
    const jIds = Array.from({ length: nJ }, (_, i) => `J${i}`);
    const candidates: Pair[] = [];
    for (const t of tIds) {
      for (const j of jIds) {
        if (rand() < 0.55) candidates.push({ transactionId: t, journalId: j });
      }
    }
    if (candidates.length < 2) continue;
    const session = create(tIds, jIds, candidates);
    // Random batch of 2 candidate pairs (possibly conflicting or jointly K-reducing).
    const shuffled = [...candidates].sort(() => rand() - 0.5);
    const batch = shuffled.slice(0, 2);
    const feasible = bruteForceFeasible(tIds, jIds, candidates, batch);
    const before = normalized(analyze(session));
    const res = resolve(session, batch);
    assert.equal(res.accepted, feasible, `seed=${seed} acceptance must match brute force`);
    if (!feasible) {
      sawRejection++;
      assert.deepEqual(normalized(analyze(session)), before, `seed=${seed} rejection must not change analysis`);
      assert.equal(session.rulings.length, 0, `seed=${seed} rejection must not record rulings`);
    }
  }
  assert.ok(sawRejection > 0, "expected some infeasible batches among random trials");
});
