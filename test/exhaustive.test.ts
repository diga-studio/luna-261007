import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCmsReader } from '../src/index';
import type { ArticleInput, EdgeInput } from '../src/types';
import { refPage, type RefArticle } from './helpers';

const articles: ArticleInput[] = [
  { id: 1, rank: 5, published: true },
  { id: 2, rank: 3, published: true },
  { id: 3, rank: 3, published: true },
  { id: 4, rank: 3, published: false },
  { id: 5, rank: 1, published: true },
  { id: 6, rank: 2, published: false },
  { id: 7, rank: 4, published: true },
];

const edges: EdgeInput[] = [
  { from: 1, to: 2 },
  { from: 1, to: 3 },
  { from: 1, to: 4 },
  { from: 1, to: 5 },
  { from: 1, to: 6 },
  { from: 1, to: 7 },
  { from: 2, to: 1 },
  { from: 2, to: 3 },
  { from: 3, to: 1 },
  { from: 3, to: 2 },
  { from: 5, to: 5 },
  { from: 5, to: 2 },
  { from: 7, to: 2 },
  { from: 7, to: 6 },
];

interface PageParams {
  offset: number;
  limit: number;
}

interface ExpectedNode {
  id: string;
  rank: number;
  related?: ExpectedNode[];
}

function expectedTree(fromId: number | null, levels: PageParams[]): ExpectedNode[] {
  const [head, ...rest] = levels;
  const page = refPage(articles, edges, fromId, head.offset, head.limit);
  return page.map((a: RefArticle) => {
    const node: ExpectedNode = { id: String(a.id), rank: a.rank };
    if (rest.length > 0) {
      node.related = expectedTree(a.id, rest);
    }
    return node;
  });
}

const QUERY = `
  query ($o0: Int, $l0: Int, $o1: Int, $l1: Int, $o2: Int, $l2: Int) {
    articles(offset: $o0, limit: $l0) {
      id
      rank
      related(offset: $o1, limit: $l1) {
        id
        rank
        related(offset: $o2, limit: $l2) {
          id
          rank
        }
      }
    }
  }
`;

test('exhaustive multi-level pagination matches reference implementation', () => {
  const reader = createCmsReader();
  reader.load(articles, edges);

  const offsets = [0, 1, 2, 3];
  const limits = [0, 1, 3, 20];
  let checked = 0;
  for (const o0 of offsets) for (const l0 of limits)
  for (const o1 of offsets) for (const l1 of limits)
  for (const o2 of offsets) for (const l2 of limits) {
    const levels: PageParams[] = [
      { offset: o0, limit: l0 },
      { offset: o1, limit: l1 },
      { offset: o2, limit: l2 },
    ];
    const result = reader.execute(QUERY, { o0, l0, o1, l1, o2, l2 }) as {
      data: { articles: ExpectedNode[] };
    };
    const expected = expectedTree(null, levels);
    assert.deepStrictEqual(
      result.data.articles,
      expected,
      `mismatch at levels=${JSON.stringify(levels)}`,
    );
    checked++;
  }
  assert.ok(checked > 0);
});

test('unpublished target before pagination boundary shifts the window', () => {
  const reader = createCmsReader();
  reader.load(articles, edges);

  const result = reader.execute(
    `{ articles(offset: 0, limit: 1) { id related(offset: 1, limit: 2) { id } } }`,
  ) as { data: { articles: { id: string; related: { id: string }[] }[] } };

  assert.equal(result.data.articles[0].id, '5');
  const root1 = reader.execute(
    `{ articles(offset: 4, limit: 1) { id related(offset: 1, limit: 2) { id } } }`,
  ) as { data: { articles: { id: string; related: { id: string }[] }[] } };
  assert.equal(root1.data.articles[0].id, '1');
  assert.deepStrictEqual(
    root1.data.articles[0].related.map((n) => n.id),
    ['2', '3'],
  );
});

test('load rebuilds data from scratch', () => {
  const reader = createCmsReader();
  reader.load(articles, edges);
  reader.load(
    [{ id: 10, rank: 0, published: true }],
    [{ from: 10, to: 10 }],
  );
  const result = reader.execute(
    `{ articles { id related { id } } }`,
  ) as { data: { articles: { id: string; related: { id: string }[] }[] } };
  assert.deepStrictEqual(result.data.articles, [
    { id: '10', related: [{ id: '10' }] },
  ]);
});

test('default offset and limit are 0 and 20', () => {
  const reader = createCmsReader();
  const many: ArticleInput[] = [];
  for (let i = 1; i <= 30; i++) {
    many.push({ id: i, rank: 100 - i, published: true });
  }
  reader.load(many, []);
  const result = reader.execute(`{ articles { id } }`) as {
    data: { articles: { id: string }[] };
  };
  assert.equal(result.data.articles.length, 20);
  assert.equal(result.data.articles[0].id, '30');
});
