/** 一道回答模板：有序片段，每段若干可选字符串（可为空字符串）。 */
export interface AnswerTemplate {
  readonly segments: readonly (readonly string[])[];
}

/** 单次判定结果。 */
export interface JudgeResult {
  /** 所有合法回答中的最高相似度，取值 [0, 1]，未四舍五入。 */
  readonly score: number;
  /** 最高相似度是否达到 80%（恰好 80% 也算达标）。 */
  readonly passed: boolean;
  /** 一条取得该最高分的合法回答。 */
  readonly answer: string;
}
