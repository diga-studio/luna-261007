import type { Matrix } from "./types.js";

/** Eigen-decomposition of a real symmetric matrix (ascending eigenvalues). */
export interface SymmetricEigen {
  readonly values: number[];
  /** columns are eigenvectors */
  readonly vectors: Matrix;
}

/**
 * Jacobi eigenvalue algorithm for real symmetric matrices.
 * Deterministic: fixed sweep order, no randomness.
 */
export function eigenSymmetric(input: Matrix): SymmetricEigen {
  const n = input.length;
  const a: number[][] = input.map((row) => row.slice());
  const v: number[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
  );

  const maxSweeps = 100;
  const tol = 1e-15;
  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        off += a[p]![q]! * a[p]![q]!;
      }
    }
    if (off <= tol * tol) break;

    for (let p = 0; p < n - 1; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = a[p]![q]!;
        if (apq === 0) continue;
        const app = a[p]![p]!;
        const aqq = a[q]![q]!;
        const theta = (aqq - app) / (2 * apq);
        const sign = theta >= 0 ? 1 : -1;
        const t = sign / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;

        for (let k = 0; k < n; k++) {
          const akp = a[k]![p]!;
          const akq = a[k]![q]!;
          a[k]![p] = c * akp - s * akq;
          a[k]![q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p]![k]!;
          const aqk = a[q]![k]!;
          a[p]![k] = c * apk - s * aqk;
          a[q]![k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k]![p]!;
          const vkq = v[k]![q]!;
          v[k]![p] = c * vkp - s * vkq;
          v[k]![q] = s * vkp + c * vkq;
        }
      }
    }
  }

  const order = Array.from({ length: n }, (_, i) => i).sort(
    (i, j) => a[i]![i]! - a[j]![j]!,
  );
  const values = order.map((i) => a[i]![i]!);
  const vectors: Matrix = Array.from({ length: n }, (_, r) =>
    order.map((i) => v[r]![i]!),
  );
  return { values, vectors };
}
