/** A single parsed page. Tokens are already segmented, NFC-normalized, lowercased. */
export interface Page {
  id: number;
  title: string[];
  body: string[];
  tags: string[];
  author: string[];
}

/** Directed weighted synonym edge. w is an integer in [0, 1000]. */
export interface SynonymEdge {
  from: string;
  to: string;
  w: number;
}

/** One search hit: page id and its integer score. */
export interface Hit {
  id: number;
  score: number;
}

/** Read-only retrieval object returned by build(). */
export interface Retriever {
  search(query: string[], k: number): Hit[];
}

/** Field ids and their fixed weights. */
export const FIELD = {
  title: 0,
  tags: 1,
  author: 2,
  body: 3,
} as const;

export type FieldId = (typeof FIELD)[keyof typeof FIELD];

export const FIELD_WEIGHT: readonly number[] = [8, 4, 2, 1];
