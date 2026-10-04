import type { EstimateResult, Matrix } from "./types";

function pairCorrelation(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  let meanX = 0;
  let meanY = 0;
  for (let k = 0; k < n; k++) {
    meanX += xs[k];
    meanY += ys[k];
  }
  meanX /= n;
  meanY /= n;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let k = 0; k < n; k++) {
    const dx = xs[k] - meanX;
    const dy = ys[k] - meanY;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  if (sxx === 0 || syy === 0) return 0;
  return sxy / Math.sqrt(sxx * syy);
}

export function estimateCorrelation(panel: (number | null)[][]): EstimateResult {
  const rows = panel.length;
  const cols = rows === 0 ? 0 : panel[0].length;
  const R: Matrix = [];
  const W: Matrix = [];
  for (let i = 0; i < cols; i++) {
    R.push(new Array<number>(cols).fill(0));
    W.push(new Array<number>(cols).fill(0));
    R[i][i] = 1;
  }
  for (let i = 0; i < cols; i++) {
    for (let j = i + 1; j < cols; j++) {
      const xs: number[] = [];
      const ys: number[] = [];
      for (let t = 0; t < rows; t++) {
        const a = panel[t][i];
        const b = panel[t][j];
        if (a !== null && b !== null) {
          xs.push(a);
          ys.push(b);
        }
      }
      const r = pairCorrelation(xs, ys);
      const w = Math.max(xs.length, 1);
      R[i][j] = r;
      R[j][i] = r;
      W[i][j] = w;
      W[j][i] = w;
    }
  }
  return { R, W };
}
