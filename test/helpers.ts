import type { ArticleInput, EdgeInput } from '../src/types';

export interface RefArticle {
  id: number;
  rank: number;
}

export function refPage(
  articles: ArticleInput[],
  edges: EdgeInput[],
  fromId: number | null,
  offset: number,
  limit: number,
): RefArticle[] {
  const byId = new Map(articles.map((a) => [a.id, a]));
  const ids = fromId === null
    ? articles.map((a) => a.id)
    : edges.filter((e) => e.from === fromId).map((e) => e.to);
  return ids
    .map((id) => byId.get(id)!)
    .filter((a) => a.published)
    .sort((x, y) => x.rank - y.rank || x.id - y.id)
    .slice(offset, offset + limit)
    .map((a) => ({ id: a.id, rank: a.rank }));
}
