import type { Matrix, RepairResult } from "./types";
import { jacobiEigen, minEigenvalue } from "./linalg";

function projectPsd(a: Matrix): Matrix {
  const n = a.length;
  const sym: Matrix = [];
  for (let i = 0; i < n; i++) {
    sym.push(new Array<number>(n).fill(0));
    for (let j = 0; j < n; j++) {
      sym[i][j] = (a[i][j] + a[j][i]) / 2;
    }
  }
  const { values, vectors } = jacobiEigen(sym);
  const out: Matrix = [];
  for (let i = 0; i < n; i++) out.push(new Array<number>(n).fill(0));
  for (let k = 0; k < n; k++) {
    const lambda = values[k] > 0 ? values[k] : 0;
    if (lambda === 0) continue;
    for (let i = 0; i < n; i++) {
      const vik = vectors[i][k];
      for (let j = 0; j < n; j++) {
        out[i][j] += lambda * vik * vectors[j][k];
      }
    }
  }
  return out;
}

function weightedObjective(C: Matrix, R: Matrix, W: Matrix): number {
  const n = C.length;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = C[i][j] - R[i][j];
      sum += W[i][j] * d * d;
    }
  }
  return sum;
}

export function repairCorrelation(R: Matrix, W: Matrix): RepairResult {
  const n = R.length;
  if (n === 0) return { C: [], objective: 0 };

  if (minEigenvalue(R) >= -1e-10) {
    return { C: R.map((row) => row.slice()), objective: 0 };
  }

  let weightSum = 0;
  let weightCount = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      weightSum += W[i][j];
      weightCount++;
    }
  }
  const rho = weightCount > 0 ? Math.max(weightSum / weightCount, 1e-8) : 1;

  const X: Matrix = R.map((row, i) => row.map((v, j) => (i === j ? 1 : v)));
  let Z: Matrix = X.map((row) => row.slice());
  const U: Matrix = [];
  for (let i = 0; i < n; i++) U.push(new Array<number>(n).fill(0));

  const maxIterations = 100000;
  const tolerance = 1e-13;
  for (let iter = 0; iter < maxIterations; iter++) {
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i === j) {
          X[i][j] = 1;
        } else {
          const w = W[i][j];
          X[i][j] = (2 * w * R[i][j] + rho * (Z[i][j] - U[i][j])) / (2 * w + rho);
        }
      }
    }
    const Znext = projectPsd(X.map((row, i) => row.map((v, j) => v + U[i][j])));
    let maxDiff = 0;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const d = Math.abs(Znext[i][j] - X[i][j]);
        if (d > maxDiff) maxDiff = d;
        U[i][j] += X[i][j] - Znext[i][j];
      }
    }
    let maxShift = 0;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const d = Math.abs(Znext[i][j] - Z[i][j]);
        if (d > maxShift) maxShift = d;
      }
    }
    Z = Znext;
    if (maxDiff < tolerance && maxShift < tolerance) break;
  }

  const C: Matrix = [];
  for (let i = 0; i < n; i++) {
    C.push(new Array<number>(n).fill(0));
    const scale = Z[i][i] > 0 ? 1 / Math.sqrt(Z[i][i]) : 0;
    for (let j = 0; j < n; j++) {
      const scaleJ = Z[j][j] > 0 ? 1 / Math.sqrt(Z[j][j]) : 0;
      C[i][j] = i === j ? 1 : (Z[i][j] + Z[j][i]) / 2 * scale * scaleJ;
    }
  }
  return { C, objective: weightedObjective(C, R, W) };
}
