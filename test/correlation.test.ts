import test from "node:test";
import assert from "node:assert/strict";
import { estimateCorrelation, repairCorrelation } from "../src/index";
import type { Matrix } from "../src/index";

function assertClose(actual: number, expected: number, tol: number, label: string): void {
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${label}: expected ${expected}, got ${actual}`,
  );
}

function assertMatrixClose(actual: Matrix, expected: Matrix, tol: number, label: string): void {
  assert.equal(actual.length, expected.length, `${label}: row count`);
  for (let i = 0; i < expected.length; i++) {
    assert.equal(actual[i].length, expected[i].length, `${label}: col count row ${i}`);
    for (let j = 0; j < expected[i].length; j++) {
      assertClose(actual[i][j], expected[i][j], tol, `${label}[${i}][${j}]`);
    }
  }
}

test("estimateCorrelation: interleaved nulls, constant column, pairwise means", () => {
  // Columns: A, B, C(constant 5), D(sparse), E(all null).
  const panel: (number | null)[][] = [
    [1, 2, 5, null, null],
    [2, null, 5, null, null],
    [null, 4, 5, 1, null],
    [4, 8, null, null, null],
    [5, null, 5, null, null],
    [6, 16, 5, null, null],
  ];
  const { R, W } = estimateCorrelation(panel);

  assert.equal(R.length, 5);
  assert.equal(W.length, 5);
  for (let i = 0; i < 5; i++) {
    assert.equal(R[i][i], 1, `R[${i}][${i}] must be 1`);
    assert.equal(W[i][i], 0, `W[${i}][${i}] unused`);
    for (let j = 0; j < 5; j++) {
      assert.equal(R[i][j], R[j][i], `R symmetric at ${i},${j}`);
      assert.equal(W[i][j], W[j][i], `W symmetric at ${i},${j}`);
    }
  }

  // Pair (A,B): common days {0,3,5} -> x=[1,4,6], y=[2,8,16].
  // Means within common sample: 11/3 and 26/3 (NOT whole-column means
  // 18/5 and 15/2). sxy=104/3, sxx=38/3, syy=296/3 -> r = 26/sqrt(703).
  assert.equal(W[0][1], 3);
  assertClose(R[0][1], 26 / Math.sqrt(703), 1e-12, "R[A][B]");

  // Pair (A,C): common days {0,1,4,5}; C constant -> r = 0.
  assert.equal(W[0][2], 4);
  assert.equal(R[0][2], 0);

  // Pair (B,C): common days {0,2,5}; C constant -> r = 0.
  assert.equal(W[1][2], 3);
  assert.equal(R[1][2], 0);

  // Pair (A,D): zero common days -> r = 0, weight floored at 1.
  assert.equal(W[0][3], 1);
  assert.equal(R[0][3], 0);

  // Pairs (B,D) and (C,D): exactly one common day -> r = 0, weight 1.
  assert.equal(W[1][3], 1);
  assert.equal(R[1][3], 0);
  assert.equal(W[2][3], 1);
  assert.equal(R[2][3], 0);

  // Column E is entirely null: every pair has zero common samples.
  for (let i = 0; i < 5; i++) {
    if (i !== 4) assert.equal(W[i][4], 1, `W[${i}][E]`);
    assert.equal(R[i][4], i === 4 ? 1 : 0, `R[${i}][E]`);
  }
});

test("repairCorrelation: weighted nearest correlation matrix, known optimum", () => {
  const R: Matrix = [
    [1, -0.096, 0.66],
    [-0.096, 1, 0.84],
    [0.66, 0.84, 1],
  ];
  const W: Matrix = [
    [0, 10, 20],
    [10, 0, 40],
    [20, 40, 0],
  ];
  const expected: Matrix = [
    [1, 0, 0.6],
    [0, 1, 0.8],
    [0.6, 0.8, 1],
  ];
  const { C, objective } = repairCorrelation(R, W);

  assertClose(objective, 0.22816, 1e-9, "objective");
  assertMatrixClose(C, expected, 1e-6, "C");
  for (let i = 0; i < 3; i++) {
    assert.equal(C[i][i], 1, `C[${i}][${i}] must be exactly 1`);
  }
});

test("repairCorrelation: singular optimum is a fixed point (no drift)", () => {
  const singular: Matrix = [
    [1, 0, 0.6],
    [0, 1, 0.8],
    [0.6, 0.8, 1],
  ];
  const W: Matrix = [
    [0, 10, 20],
    [10, 0, 40],
    [20, 40, 0],
  ];
  const { C, objective } = repairCorrelation(singular, W);

  assert.equal(objective, 0);
  assertMatrixClose(C, singular, 0, "C must be returned unchanged");
});

test("repairCorrelation: identity matrix is already valid", () => {
  const I: Matrix = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  const W: Matrix = [
    [0, 3, 5],
    [3, 0, 7],
    [5, 7, 0],
  ];
  const { C, objective } = repairCorrelation(I, W);
  assert.equal(objective, 0);
  assertMatrixClose(C, I, 0, "identity unchanged");
});
