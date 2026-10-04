import { CmsDatabase } from './db';
import { executeQuery } from './executor';
import type { ArticleInput, CmsReader, EdgeInput } from './types';

export type { ArticleInput, EdgeInput, CmsReader } from './types';

export function createCmsReader(): CmsReader {
  const db = new CmsDatabase();
  return {
    load(articles: Iterable<ArticleInput>, edges: Iterable<EdgeInput>): void {
      db.load(articles, edges);
    },
    execute(document: string, variables: Record<string, unknown> = {}): unknown {
      return executeQuery(db, document, variables);
    },
  };
}
