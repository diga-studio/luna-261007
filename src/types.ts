/** 一条门店资料（名称、电话、城市、州、邮编、单元号已统一格式）。 */
export interface NapRecord {
  name: string;
  phone: string;
  city: string;
  state: string;
  zip: string;
  /** 独立单元号；无单元号时为 null。 */
  unit: string | null;
  /** 街道文本，唯一参与歧义判定的字段。 */
  street: string;
}

/** 本地地址改写规则：把连续输入词组替换为非空输出词组。 */
export interface AddressRule {
  /** 限定州；null 表示通用于所有州。 */
  state: string | null;
  /** 连续输入词组（已按空白切分）。 */
  input: readonly string[];
  /** 非空输出词组，且不能含带数字的词元。 */
  output: readonly string[];
}

export type Verdict = "consistent" | "conflict" | "missing" | "needs_review";

/** 待核验时附给人工复核的依据。 */
export interface ReviewEvidence {
  /** 双方共同的有效词元序列。 */
  commonSequence: readonly string[];
  /** 规范资料侧的一个有效序列（与目录侧不同）。 */
  canonicalSequence: readonly string[];
  /** 目录资料侧的一个有效序列（与规范侧不同）。 */
  directorySequence: readonly string[];
}

export interface Judgment {
  verdict: Verdict;
  /** 判定为 conflict 时，列出逐项比较不一致的字段名。 */
  conflictFields?: readonly string[];
  /** 判定为 needs_review 时附带的核验依据。 */
  evidence?: ReviewEvidence;
}
