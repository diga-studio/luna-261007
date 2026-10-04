export type Matrix = number[][];

export interface EstimateResult {
  R: Matrix;
  W: Matrix;
}

export interface RepairResult {
  C: Matrix;
  objective: number;
}
