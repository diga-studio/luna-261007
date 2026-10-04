import type { CorrelationEstimate, ReturnPanel } from "./types.js";

/**
 * Pairwise-complete Pearson correlation on a day-aligned return panel.
 *
 * For each asset pair only rows where both legs are non-null are used;
 * means and variances are computed within that common sample. Pairs with
 * fewer than 2 common rows or a zero-variance leg get correlation 0.
 * Diagonal of R is fixed to 1; off-diagonal weights are max(common, 1).
 */
export function estimateCorrelation(panel: ReturnPanel): CorrelationEstimate {
  const rows = panel.length;
  const cols = rows > 0 ? panel[0]!.length : 0;

  const R: number[][] = Array.from({ length: cols }, () => new Array<number>(cols).fill(0));
  const W: number[][] = Array.from({ length: cols }, () => new Array<number>(cols).fill(0));

  for (let i = 0; i < cols; i++) {
    R[i]![i] = 1;
    W[i]![i] = 1;
  }

  for (let i = 0; i < cols; i++) {
    for (let j = i + 1; j < cols; j++) {
      let n = 0;
      let sumX = 0;
      let sumY = 0;
      for (let t = 0; t < rows; t++) {
        const x = panel[t]![i];
        const y = panel[t]![j];
        if (x !== null && x !== undefined && y !== null && y !== undefined) {
          n++;
          sumX += x;
          sumY += y;
        }
      }

      let corr = 0;
      if (n >= 2) {
        const meanX = sumX / n;
        const meanY = sumY / n;
        let sxx = 0;
        let syy = 0;
        let sxy = 0;
        for (let t = 0; t < rows; t++) {
          const x = panel[t]![i];
          const y = panel[t]![j];
          if (x !== null && x !== undefined && y !== null && y !== undefined) {
            const dx = x - meanX;
            const dy = y - meanY;
            sxx += dx * dx;
            syy += dy * dy;
            sxy += dx * dy;
          }
        }
        if (sxx > 0 && syy > 0) {
          corr = sxy / Math.sqrt(sxx * syy);
          if (corr > 1) corr = 1;
          else if (corr < -1) corr = -1;
        }
      }

      const w = Math.max(n, 1);
      R[i]![j] = corr;
      R[j]![i] = corr;
      W[i]![j] = w;
      W[j]![i] = w;
    }
  }

  return { R, W };
}
