import type { Matrix } from "./types";

export interface EigenDecomposition {
  values: number[];
  vectors: Matrix;
}

export function jacobiEigen(a: Matrix): EigenDecomposition {
  const n = a.length;
  const m: Matrix = a.map((row) => row.slice());
  const v: Matrix = [];
  for (let i = 0; i < n; i++) {
    v.push(new Array<number>(n).fill(0));
    v[i][i] = 1;
  }
  const maxSweeps = 100;
  const tol = 1e-15;
  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        off += m[p][q] * m[p][q];
      }
    }
    if (off <= tol) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = m[p][q];
        if (apq === 0) continue;
        const app = m[p][p];
        const aqq = m[q][q];
        const theta = (aqq - app) / (2 * apq);
        const sign = theta >= 0 ? 1 : -1;
        const t = sign / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const mkp = m[k][p];
          const mkq = m[k][q];
          m[k][p] = c * mkp - s * mkq;
          m[k][q] = s * mkp + c * mkq;
        }
        for (let k = 0; k < n; k++) {
          const mpk = m[p][k];
          const mqk = m[q][k];
          m[p][k] = c * mpk - s * mqk;
          m[q][k] = s * mpk + c * mqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k][p];
          const vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  const values: number[] = [];
  for (let i = 0; i < n; i++) values.push(m[i][i]);
  return { values, vectors: v };
}

export function minEigenvalue(a: Matrix): number {
  const { values } = jacobiEigen(a);
  let min = values[0];
  for (let i = 1; i < values.length; i++) {
    if (values[i] < min) min = values[i];
  }
  return min;
}
