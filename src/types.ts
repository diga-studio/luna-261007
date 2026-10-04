import type { ExecutionResult } from 'graphql';

export interface Article {
  id: number;
  rank: number;
  published: boolean;
}

export interface Edge {
  source: number;
  target: number;
}

export interface PageArgs {
  offset?: number | null;
  limit?: number | null;
}

export interface CmsComponent {
  load(articles: Iterable<Article>, edges: Iterable<Edge>): void;
  execute(
    document: string,
    variables?: Record<string, unknown>,
  ): Promise<ExecutionResult>;
}
