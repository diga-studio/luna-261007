export interface ArticleInput {
  id: number;
  rank: number;
  published: boolean;
}

export interface EdgeInput {
  from: number;
  to: number;
}

export interface CmsReader {
  load(articles: Iterable<ArticleInput>, edges: Iterable<EdgeInput>): void;
  execute(document: string, variables?: Record<string, unknown>): unknown;
}
