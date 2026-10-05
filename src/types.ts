/** A recommendation list as produced by the caller-supplied compute function. */
export type RecommendationList = string[];

/**
 * Caller-supplied asynchronous recommendation computer.
 * Receives the user id and the current data version.
 * This module never implements the recommendation algorithm itself.
 */
export type RecommendationComputer = (
  userId: string,
  version: number
) => Promise<RecommendationList>;

/** Discriminated result so callers can tell fresh / stale-fallback / unavailable apart. */
export type QueryResult =
  | {
      kind: "fresh";
      userId: string;
      version: number;
      items: RecommendationList;
    }
  | {
      kind: "stale";
      userId: string;
      version: number;
      items: RecommendationList;
    }
  | {
      kind: "unavailable";
      userId: string;
      version: number;
    };

export interface RecommendationCacheOptions {
  /** The local async recommendation computer supplied by the caller. */
  compute: RecommendationComputer;
  /** Initial global data version. Defaults to 0. */
  initialVersion?: number;
  /** Per-query wait budget in ms. Defaults to 5000. */
  budgetMs?: number;
  /** How long a successful result stays fresh, in ms. Defaults to 600000. */
  freshMs?: number;
}
