import assert from "node:assert/strict";
import test from "node:test";
import { estimateCorrelation } from "../src/index.js";

// Interleaved missing values plus a constant column (C) and a column (D)
// that shares fewer than 2 common rows with every other column.
//
//        t0    t1    t2    t3    t4    t5
//  A  [  1,    2,    3,  null,   5,    4 ]
//  B  [  2, null,    1,    3, null,    0 ]
//  C  [0.5,  0.5, null,  0.5,  0.5,  0.5 ]
//  D  [null, null, null,   7, null, null ]
const panel: (number | null)[][] = [
  [1, 2, 0.5, null],
  [2, null, 0.5, null],
  [3, 1, null, null],
  [null, 3, 0.5, 7],
  [5, null, 0.5, null],
  [4, 0, 0.5, null],
];

test("pairwise-complete correlation with interleaved missing data", () => {
  const { R, W } = estimateCorrelation(panel);

  assert.equal(R.length, 4);
  assert.equal(W.length, 4);

  // Diagonal fixed to 1.
  for (let i = 0; i < 4; i++) {
    assert.equal(R[i]![i], 1);
    assert.equal(W[i]![i], 1);
  }

  // Pair (A, B): common rows t0, t2, t5 -> (1,2), (3,1), (4,0), n = 3.
  // Means within the common sample: meanA = 8/3, meanB = 1.
  // sxy = -3, sxx = 14/3, syy = 2  =>  r = -3 / sqrt(28/3).
  // (Whole-column means 3 and 1.5 would give a different value, so this
  // fails if means are not computed on the common sample.)
  const expectedAB = -3 / Math.sqrt(28 / 3);
  assert.ok(Math.abs(R[0]![1]! - expectedAB) < 1e-12, `R[0][1]=${R[0]![1]}`);
  assert.equal(R[1]![0], R[0]![1]);
  assert.equal(W[0]![1], 3);
  assert.equal(W[1]![0], 3);

  // Pair (A, C): common rows t0, t1, t4, t5 -> n = 4, but C is constant
  // on the common sample (zero variance) => correlation 0.
  assert.equal(R[0]![2], 0);
  assert.equal(R[2]![0], 0);
  assert.equal(W[0]![2], 4);
  assert.equal(W[2]![0], 4);

  // Pair (B, C): common rows t0, t3, t5 -> n = 3, C constant => 0.
  assert.equal(R[1]![2], 0);
  assert.equal(W[1]![2], 3);

  // Pair (A, D): zero common rows -> correlation 0, weight floor 1.
  assert.equal(R[0]![3], 0);
  assert.equal(W[0]![3], 1);

  // Pairs (B, D) and (C, D): exactly one common row (< 2) -> 0, weight 1.
  assert.equal(R[1]![3], 0);
  assert.equal(W[1]![3], 1);
  assert.equal(R[2]![3], 0);
  assert.equal(W[2]![3], 1);

  // Full symmetry of both matrices.
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      assert.equal(R[i]![j], R[j]![i]);
      assert.equal(W[i]![j], W[j]![i]);
    }
  }
});

test("constant column never produces NaN", () => {
  const { R } = estimateCorrelation([
    [1, 7],
    [2, 7],
    [3, 7],
  ]);
  assert.equal(R[0]![1], 0);
  assert.equal(R[1]![0], 0);
});
