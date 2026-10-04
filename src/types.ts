/**
 * 一个回答模板：有序片段组成的数组，每个片段是若干可选字符串。
 * 从每段恰选一个选项，按原顺序直接拼接（不添加空格）即得一条合法回答。
 */
export type AnswerTemplate = string[][];

/** 单次判定结果。 */
export interface JudgeResult {
  /** 所有合法回答中的最高相似度，取值 [0, 1]，未做四舍五入。 */
  readonly similarity: number;
  /** 最高相似度是否达到 80%（恰好 80% 也算达标），按未取整比例判定。 */
  readonly passed: boolean;
  /** 一条取得最高相似度的合法回答；并列最优时返回任意一条。 */
  readonly answer: string;
}

/** 输入规模上限（超出时构造器/判定会抛错）。 */
export const LIMITS = {
  maxTemplates: 4,
  maxSegmentsPerTemplate: 48,
  maxOptionsPerSegment: 3,
  maxOptionCodePoints: 4,
  maxAnswerCodePoints: 128,
} as const;

/** 达标阈值：80%，以未四舍五入的比例为准。 */
export const PASS_THRESHOLD = 0.8;
