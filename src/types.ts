/** 16 维特征向量，每维为 0-255 的整数（上游已完成量化）。 */
export type FeatureVector = readonly number[];

/** 样本池中的一条样本。 */
export interface SampleInput {
  /** 唯一的非负整数 ID。 */
  readonly id: number;
  readonly features: FeatureVector;
}

/** 上游聚类得到的代表点（不是待选样本，不要求出现在样本池中）。 */
export interface RepresentativeInput {
  readonly features: FeatureVector;
  /** 1 到 10000 的整数，表示该代表点代表的样本数量。 */
  readonly weight: number;
}

/** 建立选样会话所需的输入。 */
export interface SessionConfig {
  /** 固定的样本池。 */
  readonly samples: readonly SampleInput[];
  /** 上游聚类得到的代表点。 */
  readonly representatives: readonly RepresentativeInput[];
  /** 会话建立时已标注的样本 ID 集合。 */
  readonly labeledIds?: readonly number[];
}

/** 特征维度数。 */
export const FEATURE_DIM = 16;

/** 特征每维取值上限（闭区间）。 */
export const FEATURE_MAX = 255;

/** 两条 16 维特征之间的最大可能距离：16 * 255^2。 */
export const MAX_DISTANCE = 1_040_400;
