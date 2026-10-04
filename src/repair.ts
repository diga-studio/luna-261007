import { eigenSymmetric } from "./linalg.js";
import type { Matrix, RepairResult } from "./types.js";

function symmetrize(a: Matrix): Matrix {
  const n = a.length;
  const out: Matrix = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      out[i]![j] = i === j ? a[i]![j]! : (a[i]![j]! + a[j]![i]!) / 2;
    }
  }
  return out;
}

/** Nearest PSD matrix to `a` in Frobenius norm (spectral truncation). */
function projectPsd(a: Matrix): Matrix {
  const n = a.length;
  const { values, vectors } = eigenSymmetric(symmetrize(a));
  const out: Matrix = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let k = 0; k < n; k++) {
    const lambda = values[k]!;
    if (lambda <= 0) continue;
    for (let i = 0; i < n; i++) {
      const vik = vectors[i]![k]!;
      for (let j = 0; j < n; j++) {
        out[i]![j]! += lambda * vik * vectors[j]![k]!;
      }
    }
  }
  return out;
}

/** Projection onto the affine set of unit-diagonal matrices. */
function projectDiag(a: Matrix): Matrix {
  const out = a.map((row) => row.slice());
  for (let i = 0; i < out.length; i++) out[i]![i] = 1;
  return out;
}

function frobeniusDiff(a: Matrix, b: Matrix): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < a[i]!.length; j++) {
      const d = a[i]![j]! - b[i]![j]!;
      s += d * d;
    }
  }
  return Math.sqrt(s);
}

/**
 * Dykstra's alternating projections onto {PSD} ∩ {diag = 1}.
 * Both projections are exact, so the iterates converge to the nearest
 * feasible matrix to `target` in Frobenius norm.
 */
function projectFeasible(target: Matrix): Matrix {
  const n = target.length;
  let x: Matrix = target.map((row) => row.slice());
  let p: Matrix = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  let q: Matrix = Array.from({ length: n }, () => new Array<number>(n).fill(0));

  const tol = 1e-13 * Math.max(1, n);
  for (let iter = 0; iter < 5000; iter++) {
    const yInput: Matrix = x.map((row, i) => row.map((v, j) => v + p[i]![j]!));
    const y = projectDiag(yInput);
    p = yInput.map((row, i) => row.map((v, j) => v - y[i]![j]!));

    const xInput: Matrix = y.map((row, i) => row.map((v, j) => v + q[i]![j]!));
    const xNext = projectPsd(xInput);
    q = xInput.map((row, i) => row.map((v, j) => v - xNext[i]![j]!));

    if (frobeniusDiff(xNext, y) <= tol) {
      x = xNext;
      break;
    }
    x = xNext;
  }
  return x;
}

/**
 * Weighted nearest correlation matrix:
 *   minimize  sum_{i<j} W[i][j] * (C[i][j] - R[i][j])^2
 *   subject to C symmetric, PSD, diag(C) = 1.
 *
 * Solved by a majorization-minimization loop: with weights scaled into
 * [0, 1], the weighted objective is majorized by an unweighted Frobenius
 * problem whose solution is the exact projection onto the feasible set
 * (Dykstra). The objective decreases monotonically to the global minimum
 * of this strictly convex problem.
 */
export function repairCorrelation(R: Matrix, W: Matrix): RepairResult {
  const n = R.length;

  let wMax = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      wMax = Math.max(wMax, W[i]![j]!);
    }
  }

  const objectiveOf = (c: Matrix): number => {
    let f = 0;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const d = c[i]![j]! - R[i]![j]!;
        f += W[i]![j]! * d * d;
      }
    }
    return f;
  };

  if (n === 0) return { C: [], objective: 0 };
  if (n === 1 || wMax === 0) {
    const c: Matrix = Array.from({ length: n }, (_, i) =>
      Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
    );
    return { C: c, objective: objectiveOf(c) };
  }

  // Scaled weights in [0, 1]; diagonal never used.
  const w: Matrix = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 0 : W[i]![j]! / wMax)),
  );

  let x: Matrix = projectFeasible(R);
  for (let iter = 0; iter < 20000; iter++) {
    // Majorizer minimizer: project (x - w .* (x - R)) onto the feasible set.
    const y: Matrix = x.map((row, i) =>
      row.map((v, j) => (i === j ? 1 : v - w[i]![j]! * (v - R[i]![j]!))),
    );
    const xNext = projectFeasible(y);
    const step = frobeniusDiff(xNext, x);
    x = xNext;
    if (step <= 1e-13 * Math.max(1, n)) break;
  }

  const C = projectDiag(symmetrize(x));
  return { C, objective: objectiveOf(C) };
}
