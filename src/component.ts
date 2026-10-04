import { graphql } from 'graphql';
import type { ExecutionResult } from 'graphql';
import { CmsDatabase } from './db';
import { buildSchema } from './schema';
import type { Article, CmsComponent, Edge } from './types';

export function createCms(): CmsComponent {
  const db = new CmsDatabase();
  const schema = buildSchema(db);

  return {
    load(articles: Iterable<Article>, edges: Iterable<Edge>): void {
      db.load(articles, edges);
    },
    execute(
      document: string,
      variables?: Record<string, unknown>,
    ): Promise<ExecutionResult> {
      return graphql({
        schema,
        source: document,
        variableValues: variables,
      });
    },
  };
}
