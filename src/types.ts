/** Dense row-major square matrix. */
export type Matrix = number[][];

/** Return panel: rows are trading days, columns are assets; null = missing. */
export type ReturnPanel = (number | null)[][];

/** Result of correlation estimation on a return panel. */
export interface CorrelationEstimate {
  /** Raw pairwise-complete Pearson correlation matrix; diagonal fixed to 1. */
  readonly R: Matrix;
  /** Confidence weights; off-diagonal W[i][j] = max(commonSamples, 1). */
  readonly W: Matrix;
}

/** Result of the weighted nearest-correlation repair. */
export interface RepairResult {
  /** Symmetric, positive semidefinite, unit-diagonal repaired matrix. */
  readonly C: Matrix;
  /** Global minimum of sum_{i<j} W[i][j] * (C[i][j] - R[i][j])^2. */
  readonly objective: number;
}
