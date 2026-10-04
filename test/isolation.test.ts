import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCmsReader } from '../src/index';
import type { ArticleInput, EdgeInput } from '../src/types';
import { refPage } from './helpers';

const articles: ArticleInput[] = [
  { id: 1, rank: 1, published: true },
  { id: 2, rank: 2, published: true },
  { id: 3, rank: 3, published: true },
  { id: 4, rank: 4, published: false },
  { id: 5, rank: 5, published: true },
  { id: 6, rank: 6, published: true },
];

const edges: EdgeInput[] = [
  { from: 1, to: 2 },
  { from: 1, to: 3 },
  { from: 1, to: 4 },
  { from: 1, to: 5 },
  { from: 1, to: 6 },
  { from: 2, to: 1 },
  { from: 3, to: 1 },
  { from: 5, to: 1 },
  { from: 6, to: 1 },
];

const QUERY = `
  query ($show: Boolean!, $hide: Boolean!, $off: Int) {
    articles(offset: 0, limit: 1) {
      id
      a: related(offset: 0, limit: 2) { id }
      b: related(offset: 2, limit: 2) { id rank }
      ...F1
      ...F2
      ... on Article {
        c: related(offset: $off, limit: 10) @include(if: $show) { id }
      }
      d: related(offset: 1, limit: 1) @skip(if: $hide) { id }
    }
  }
  fragment F1 on Article {
    id
    rank
  }
  fragment F2 on Article {
    rank
    e: related(offset: 3, limit: 1) { id }
  }
`;

interface RelatedNode {
  id: string;
  rank?: number;
}

function expectedRelated(offset: number, limit: number) {
  return refPage(articles, edges, 1, offset, limit).map((a) => ({
    id: String(a.id),
  }));
}

test('aliases with different args stay isolated; fragments merge; directives toggle', () => {
  const reader = createCmsReader();
  reader.load(articles, edges);

  const result = reader.execute(QUERY, { show: true, hide: false, off: 1 }) as {
    data: {
      articles: ({
        id: string;
        rank: number;
        a: RelatedNode[];
        b: RelatedNode[];
        c?: RelatedNode[];
        d?: RelatedNode[];
        e: RelatedNode[];
      })[];
    };
  };

  const root = result.data.articles[0];
  assert.equal(root.id, '1');
  assert.equal(root.rank, 1);
  assert.deepStrictEqual(root.a, expectedRelated(0, 2));
  assert.deepStrictEqual(
    root.b,
    refPage(articles, edges, 1, 2, 2).map((x) => ({ id: String(x.id), rank: x.rank })),
  );
  assert.deepStrictEqual(root.c, expectedRelated(1, 10));
  assert.deepStrictEqual(root.d, expectedRelated(1, 1));
  assert.deepStrictEqual(root.e, expectedRelated(3, 1));
  assert.deepStrictEqual(root.a, [
    { id: '2' },
    { id: '3' },
  ]);
  assert.deepStrictEqual(root.e, [{ id: '6' }]);

  const toggled = reader.execute(QUERY, { show: false, hide: true, off: 1 }) as {
    data: { articles: Record<string, unknown>[] };
  };
  const root2 = toggled.data.articles[0];
  assert.ok(!('c' in root2), 'c must be excluded by @include(if: false)');
  assert.ok(!('d' in root2), 'd must be excluded by @skip(if: true)');
  assert.deepStrictEqual(root2.a, expectedRelated(0, 2));
  assert.deepStrictEqual(root2.e, expectedRelated(3, 1));
});

test('variable defaults in operation definition apply when variable is missing', () => {
  const reader = createCmsReader();
  reader.load(articles, edges);
  const result = reader.execute(
    `query ($lim: Int = 2, $off: Int = 1) {
      articles(offset: $off, limit: $lim) { id }
    }`,
  ) as { data: { articles: { id: string }[] } };
  assert.deepStrictEqual(result.data.articles, [{ id: '2' }, { id: '3' }]);
});

test('same article reached via different paths gets independent pagination', () => {
  const reader = createCmsReader();
  reader.load(articles, edges);
  const result = reader.execute(
    `{
      x: articles(offset: 0, limit: 1) { id related(offset: 0, limit: 1) { id } }
    }`,
  ) as { data: { x: { id: string; related: { id: string }[] }[] } };
  assert.deepStrictEqual(result.data.x, [
    { id: '1', related: [{ id: '2' }] },
  ]);

  const nested = reader.execute(
    `{
      articles(offset: 1, limit: 1) {
        id
        related(offset: 0, limit: 1) { id related(offset: 0, limit: 3) { id } }
      }
    }`,
  ) as {
    data: {
      articles: { id: string; related: { id: string; related: { id: string }[] }[] }[];
    };
  };
  assert.deepStrictEqual(nested.data.articles, [
    {
      id: '2',
      related: [
        { id: '1', related: [{ id: '2' }, { id: '3' }, { id: '5' }] },
      ],
    },
  ]);
});
