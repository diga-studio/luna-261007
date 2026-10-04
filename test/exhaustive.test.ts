import test from 'node:test';
import assert from 'node:assert/strict';
import { createCms } from '../src/index';
import type { CmsComponent } from '../src/types';
import { ARTICLES, EDGES, refArticles, refRelated } from './fixture';

interface GqlNode {
  id: string;
  rank: number;
  related?: GqlNode[];
}

function freshCms(): CmsComponent {
  const cms = createCms();
  cms.load(ARTICLES, EDGES);
  return cms;
}

async function run(
  cms: CmsComponent,
  document: string,
  variables?: Record<string, unknown>,
): Promise<Record<string, GqlNode[]>> {
  const result = await cms.execute(document, variables);
  assert.deepEqual(result.errors, undefined);
  return (result.data ?? {}) as Record<string, GqlNode[]>;
}

function assertNodesEqual(actual: GqlNode[], expected: { id: number; rank: number }[]): void {
  assert.deepEqual(
    actual.map((n) => ({ id: Number(n.id), rank: n.rank })),
    expected.map((n) => ({ id: n.id, rank: n.rank })),
  );
}

const OFFSETS = [0, 1, 2, 3, 4, 6];
const LIMITS = [0, 1, 2, 3, 5, 20];

test('root articles: exhaustive offset/limit vs reference', async () => {
  const cms = freshCms();
  for (const offset of OFFSETS) {
    for (const limit of LIMITS) {
      const data = await run(
        cms,
        `{ articles(offset: ${offset}, limit: ${limit}) { id rank } }`,
      );
      assertNodesEqual(
        data.articles,
        refArticles(ARTICLES, offset, limit),
      );
    }
  }
});

test('depth-2: every parent page x every related page vs reference', async () => {
  const cms = freshCms();
  for (const o1 of OFFSETS) {
    for (const l1 of LIMITS) {
      for (const o2 of OFFSETS) {
        for (const l2 of LIMITS) {
          const data = await run(
            cms,
            `{ articles(offset: ${o1}, limit: ${l1}) {
                 id rank
                 related(offset: ${o2}, limit: ${l2}) { id rank }
               } }`,
          );
          const expectedParents = refArticles(ARTICLES, o1, l1);
          assertNodesEqual(data.articles, expectedParents);
          for (let i = 0; i < expectedParents.length; i++) {
            assertNodesEqual(
              data.articles[i].related!,
              refRelated(ARTICLES, EDGES, expectedParents[i].id, o2, l2),
            );
          }
        }
      }
    }
  }
});

test('depth-3: nested pagination combos vs recursive reference', async () => {
  const cms = freshCms();
  const combos = [0, 1, 2, 3];
  for (const o1 of combos) for (const l1 of combos) {
    for (const o2 of combos) for (const l2 of combos) {
      for (const o3 of combos) for (const l3 of combos) {
        const data = await run(
          cms,
          `{ articles(offset: ${o1}, limit: ${l1}) {
               id rank
               related(offset: ${o2}, limit: ${l2}) {
                 id rank
                 related(offset: ${o3}, limit: ${l3}) { id rank }
               }
             } }`,
        );
        const level1 = refArticles(ARTICLES, o1, l1);
        assertNodesEqual(data.articles, level1);
        for (let i = 0; i < level1.length; i++) {
          const level2 = refRelated(ARTICLES, EDGES, level1[i].id, o2, l2);
          assertNodesEqual(data.articles[i].related!, level2);
          for (let j = 0; j < level2.length; j++) {
            const level3 = refRelated(ARTICLES, EDGES, level2[j].id, o3, l3);
            assertNodesEqual(data.articles[i].related![j].related!, level3);
          }
        }
      }
    }
  }
});

test('unpublished target before pagination boundary is skipped, not counted', async () => {
  const cms = freshCms();
  const data = await run(
    cms,
    `{ articles(offset: 0, limit: 20) {
         id
         related(offset: 1, limit: 1) { id rank }
       } }`,
  );
  const parents = refArticles(ARTICLES, 0, 20);
  for (let i = 0; i < parents.length; i++) {
    assertNodesEqual(
      data.articles[i].related!,
      refRelated(ARTICLES, EDGES, parents[i].id, 1, 1),
    );
  }
  const article1Index = parents.findIndex((p) => p.id === 1);
  assert.deepEqual(
    data.articles[article1Index].related!.map((n) => Number(n.id)),
    [2],
  );
});

test('load rebuilds data from scratch', async () => {
  const cms = createCms();
  cms.load(ARTICLES, EDGES);
  cms.load(
    [{ id: 9, rank: 1, published: true }],
    [],
  );
  const data = await run(cms, `{ articles { id rank related { id } } }`);
  assert.deepEqual(JSON.parse(JSON.stringify(data.articles)), [
    { id: '9', rank: 1, related: [] },
  ]);
});
