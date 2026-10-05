/** 一页的四组词元。词元已完成 NFC 归一化与小写化。 */
export interface Page {
  id: number;
  title: string[];
  body: string[];
  tags: string[];
  author: string[];
}

/** 有向同义边，w 为 0..1000 的整数。 */
export interface SynonymEdge {
  from: string;
  to: string;
  w: number;
}

export interface SearchResult {
  id: number;
  score: number;
}

export interface Searcher {
  search(query: string[], k: number): SearchResult[];
}

export const FIELD_WEIGHTS = {
  title: 8,
  tags: 4,
  author: 2,
  body: 1,
} as const;

export type FieldName = keyof typeof FIELD_WEIGHTS;

export const FIELD_NAMES: readonly FieldName[] = ['title', 'tags', 'author', 'body'];

export const TYPO_CONFIDENCE = 600;
export const EXACT_CONFIDENCE = 1000;
