import assert from "node:assert/strict";
import test from "node:test";
import { repairCorrelation } from "../src/index.js";
import { eigenSymmetric } from "../src/linalg.js";
import type { Matrix } from "../src/types.js";

const R: Matrix = [
  [1, -0.096, 0.66],
  [-0.096, 1, 0.84],
  [0.66, 0.84, 1],
];
const W: Matrix = [
  [1, 10, 20],
  [10, 1, 40],
  [20, 40, 1],
];

// Unique global minimizer (KKT-verified, singular).
const EXPECTED: Matrix = [
  [1, 0, 0.6],
  [0, 1, 0.8],
  [0.6, 0.8, 1],
];
const EXPECTED_OBJECTIVE = 0.22816;

function assertSymmetricUnitDiagPsd(C: Matrix, tol: number): void {
  const n = C.length;
  for (let i = 0; i < n; i++) {
    assert.ok(Math.abs(C[i]![i]! - 1) < tol, `diag ${i}`);
    for (let j = i + 1; j < n; j++) {
      assert.ok(Math.abs(C[i]![j]! - C[j]![i]!) < tol, `symmetry ${i},${j}`);
    }
  }
  const { values } = eigenSymmetric(C);
  assert.ok(values[0]! >= -tol, `min eigenvalue ${values[0]}`);
}

test("weighted repair reaches the unique global minimum", () => {
  const { C, objective } = repairCorrelation(R, W);

  // Optimal objective value: 10*0.096^2 + 20*0.06^2 + 40*0.04^2 = 0.22816.
  assert.ok(Math.abs(objective - EXPECTED_OBJECTIVE) < 1e-9, `objective ${objective}`);

  // Matrix elements of the unique minimizer.
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      assert.ok(
        Math.abs(C[i]![j]! - EXPECTED[i]![j]!) < 1e-8,
        `C[${i}][${j}]=${C[i]![j]} expected ${EXPECTED[i]![j]}`,
      );
    }
  }

  // Structural guarantees: symmetric, unit diagonal, PSD, and singular.
  assertSymmetricUnitDiagPsd(C, 1e-9);
  const { values } = eigenSymmetric(C);
  assert.ok(Math.abs(values[0]!) < 1e-8, `expected singular, min eigenvalue ${values[0]}`);
});

test("repairing the singular optimum does not drift", () => {
  const first = repairCorrelation(R, W);
  const second = repairCorrelation(first.C, W);

  assert.ok(Math.abs(second.objective) < 1e-12, `objective ${second.objective}`);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      assert.ok(
        Math.abs(second.C[i]![j]! - first.C[i]![j]!) < 1e-9,
        `drift at ${i},${j}: ${first.C[i]![j]} -> ${second.C[i]![j]}`,
      );
    }
  }
});

test("an already feasible matrix is returned unchanged", () => {
  const feasible: Matrix = [
    [1, 0.5, 0.3],
    [0.5, 1, 0.4],
    [0.3, 0.4, 1],
  ];
  const { C, objective } = repairCorrelation(feasible, W);
  assert.ok(Math.abs(objective) < 1e-12, `objective ${objective}`);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      assert.ok(Math.abs(C[i]![j]! - feasible[i]![j]!) < 1e-9, `C[${i}][${j}]`);
    }
  }
});

test("repaired matrix is always a valid correlation matrix", () => {
  // Deterministic pseudo-random non-PSD target (fixed LCG seed).
  let seed = 42;
  const rand = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const n = 6;
  const r: Matrix = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
  );
  const w: Matrix = Array.from({ length: n }, () => new Array<number>(n).fill(1));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const v = rand() * 2 - 1;
      r[i]![j] = v;
      r[j]![i] = v;
      const weight = 1 + Math.floor(rand() * 50);
      w[i]![j] = weight;
      w[j]![i] = weight;
    }
  }

  const { C, objective } = repairCorrelation(r, w);
  assert.ok(Number.isFinite(objective) && objective >= 0);
  assertSymmetricUnitDiagPsd(C, 1e-9);

  // Objective of the repair is no worse than the (infeasible) input's zero
  // baseline sanity check: it must beat any infeasible "solution" claim by
  // being feasible itself; here we simply confirm determinism.
  const again = repairCorrelation(r, w);
  assert.equal(again.objective, objective);
});
