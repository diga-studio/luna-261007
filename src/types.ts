/** 一条本地地址改写规则：把连续输入词组替换为非空输出词组。 */
export interface AddressRule {
  /** 连续输入词元序列（不含带数字的词元）。 */
  readonly from: readonly string[];
  /** 非空输出词元序列（不含带数字的词元）。 */
  readonly to: readonly string[];
  /** 限定的州；省略表示通用于所有州。 */
  readonly state?: string;
}

/** 已统一格式的门店资料字段（规范资料与目录资料共用）。 */
export interface NapProfile {
  readonly name: string;
  readonly phone: string;
  readonly street: string;
  readonly city: string;
  readonly state: string;
  readonly postalCode: string;
  /** 独立单元号；无单元号时为 null。 */
  readonly unit: string | null;
}

export type Verdict = "consistent" | "conflict" | "missing" | "needs_review";

/** 待核验时附带的人工复核依据。 */
export interface ReviewEvidence {
  /** 双方共同的一个有效词元序列。 */
  readonly commonSequence: readonly string[];
  /** 规范资料一侧与另一侧不同的有效序列。 */
  readonly canonicalOnlySequence: readonly string[];
  /** 目录资料一侧与另一侧不同的有效序列。 */
  readonly directoryOnlySequence: readonly string[];
}

export interface EvaluationResult {
  readonly verdict: Verdict;
  /** 仅当 verdict 为 "needs_review" 时存在。 */
  readonly evidence?: ReviewEvidence;
}
