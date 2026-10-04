import type { Article, Edge } from '../src/types';

export const ARTICLES: Article[] = [
  { id: 1, rank: 5, published: true },
  { id: 2, rank: 3, published: true },
  { id: 3, rank: 3, published: true },
  { id: 4, rank: 1, published: true },
  { id: 5, rank: 2, published: false },
  { id: 6, rank: 0, published: true },
  { id: 7, rank: 4, published: false },
];

export const EDGES: Edge[] = [
  { source: 1, target: 2 },
  { source: 1, target: 5 },
  { source: 1, target: 6 },
  { source: 2, target: 3 },
  { source: 2, target: 1 },
  { source: 3, target: 3 },
  { source: 3, target: 7 },
  { source: 4, target: 2 },
  { source: 4, target: 3 },
  { source: 6, target: 4 },
  { source: 5, target: 1 },
];

export interface RefNode {
  id: number;
  rank: number;
}

function sortByRankThenId(nodes: RefNode[]): RefNode[] {
  return [...nodes].sort((a, b) => a.rank - b.rank || a.id - b.id);
}

function page<T>(items: T[], offset = 0, limit = 20): T[] {
  return items.slice(offset, offset + limit);
}

export function refArticles(
  articles: Article[],
  offset = 0,
  limit = 20,
): RefNode[] {
  return page(
    sortByRankThenId(articles.filter((a) => a.published)),
    offset,
    limit,
  );
}

export function refRelated(
  articles: Article[],
  edges: Edge[],
  sourceId: number,
  offset = 0,
  limit = 20,
): RefNode[] {
  const byId = new Map(articles.map((a) => [a.id, a]));
  const targets = edges
    .filter((e) => e.source === sourceId)
    .map((e) => byId.get(e.target)!)
    .filter((a) => a.published);
  return page(sortByRankThenId(targets), offset, limit);
}
