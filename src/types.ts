export const FEATURE_DIM = 16;
export const FEATURE_MIN = 0;
export const FEATURE_MAX = 255;
export const WEIGHT_MIN = 1;
export const WEIGHT_MAX = 10000;
export const MAX_BATCH = 200;
/** 16 * 255 * 255, cost of a representative when nothing is labeled/selected. */
export const EMPTY_COVER_COST = 1040400;

export interface SampleInput {
  /** unique non-negative integer id */
  id: number;
  /** 16 integers in [0, 255] */
  features: ArrayLike<number>;
}

export interface RepresentativeInput {
  /** 16 integers in [0, 255] */
  features: ArrayLike<number>;
  /** integer in [1, 10000] */
  weight: number;
}

export interface SessionConfig {
  samples: ReadonlyArray<SampleInput>;
  representatives: ReadonlyArray<RepresentativeInput>;
  labeledIds?: Iterable<number>;
}
