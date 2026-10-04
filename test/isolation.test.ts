import test from 'node:test';
import assert from 'node:assert/strict';
import { createCms } from '../src/index';
import type { CmsComponent } from '../src/types';
import { ARTICLES, EDGES, refArticles, refRelated } from './fixture';

function freshCms(): CmsComponent {
  const cms = createCms();
  cms.load(ARTICLES, EDGES);
  return cms;
}

async function run(
  cms: CmsComponent,
  document: string,
  variables?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await cms.execute(document, variables);
  assert.deepEqual(result.errors, undefined);
  return JSON.parse(JSON.stringify(result.data ?? {}));
}

function idsOf(nodes: Array<{ id: string }>): number[] {
  return nodes.map((n) => Number(n.id));
}

test('same relation under multiple aliases with different args stays isolated', async () => {
  const cms = freshCms();
  const data = (await run(
    cms,
    `{ articles(offset: 0, limit: 20) {
         id
         first: related(offset: 0, limit: 1) { id }
         rest: related(offset: 1, limit: 20) { id }
         all: related { id }
       } }`,
  )) as { articles: Array<Record<string, unknown>> };

  const parents = refArticles(ARTICLES, 0, 20);
  assert.equal(data.articles.length, parents.length);
  for (let i = 0; i < parents.length; i++) {
    const row = data.articles[i];
    const pid = parents[i].id;
    assert.deepEqual(
      idsOf(row.first as Array<{ id: string }>),
      refRelated(ARTICLES, EDGES, pid, 0, 1).map((n) => n.id),
    );
    assert.deepEqual(
      idsOf(row.rest as Array<{ id: string }>),
      refRelated(ARTICLES, EDGES, pid, 1, 20).map((n) => n.id),
    );
    assert.deepEqual(
      idsOf(row.all as Array<{ id: string }>),
      refRelated(ARTICLES, EDGES, pid).map((n) => n.id),
    );
  }
});

test('named fragments, inline fragments and variables compose correctly', async () => {
  const cms = freshCms();
  const document = `
    query Paged($off: Int!, $lim: Int!, $withRank: Boolean!) {
      articles(offset: $off, limit: $lim) {
        ...Summary
        ... on Article {
          extra: related(offset: 1, limit: 1) { id }
        }
      }
    }
    fragment Summary on Article {
      id
      rank @include(if: $withRank)
      related(offset: 0, limit: 2) { id }
    }
  `;
  const withRank = (await run(cms, document, { off: 1, lim: 3, withRank: true })) as {
    articles: Array<Record<string, unknown>>;
  };
  const withoutRank = (await run(cms, document, {
    off: 1,
    lim: 3,
    withRank: false,
  })) as { articles: Array<Record<string, unknown>> };

  const parents = refArticles(ARTICLES, 1, 3);
  assert.equal(withRank.articles.length, parents.length);
  for (let i = 0; i < parents.length; i++) {
    const pid = parents[i].id;
    const a = withRank.articles[i];
    const b = withoutRank.articles[i];
    assert.equal(Number(a.id), pid);
    assert.equal(a.rank, parents[i].rank);
    assert.equal('rank' in b, false);
    for (const row of [a, b]) {
      assert.deepEqual(
        idsOf(row.related as Array<{ id: string }>),
        refRelated(ARTICLES, EDGES, pid, 0, 2).map((n) => n.id),
      );
      assert.deepEqual(
        idsOf(row.extra as Array<{ id: string }>),
        refRelated(ARTICLES, EDGES, pid, 1, 1).map((n) => n.id),
      );
    }
  }
});

test('@skip removes a selection without affecting sibling aliases', async () => {
  const cms = freshCms();
  const document = `
    query SkipTest($skipIt: Boolean!) {
      articles(offset: 0, limit: 2) {
        id
        kept: related(offset: 0, limit: 1) { id }
        dropped: related(offset: 0, limit: 1) @skip(if: $skipIt) { id }
      }
    }
  `;
  const shown = (await run(cms, document, { skipIt: false })) as {
    articles: Array<Record<string, unknown>>;
  };
  const hidden = (await run(cms, document, { skipIt: true })) as {
    articles: Array<Record<string, unknown>>;
  };
  const parents = refArticles(ARTICLES, 0, 2);
  for (let i = 0; i < parents.length; i++) {
    const expected = refRelated(ARTICLES, EDGES, parents[i].id, 0, 1).map((n) => n.id);
    assert.deepEqual(idsOf(shown.articles[i].kept as Array<{ id: string }>), expected);
    assert.deepEqual(idsOf(shown.articles[i].dropped as Array<{ id: string }>), expected);
    assert.deepEqual(idsOf(hidden.articles[i].kept as Array<{ id: string }>), expected);
    assert.equal('dropped' in hidden.articles[i], false);
  }
});

test('same article reached via different nested paths paginates independently', async () => {
  const cms = freshCms();
  const data = (await run(
    cms,
    `{ articles(offset: 0, limit: 20) {
         id
         hop1: related(offset: 0, limit: 20) {
           id
           hop2: related(offset: 1, limit: 1) { id }
         }
       } }`,
  )) as {
    articles: Array<{
      id: string;
      hop1: Array<{ id: string; hop2: Array<{ id: string }> }>;
    }>;
  };

  const parents = refArticles(ARTICLES, 0, 20);
  for (let i = 0; i < parents.length; i++) {
    const hop1 = refRelated(ARTICLES, EDGES, parents[i].id, 0, 20);
    assert.deepEqual(idsOf(data.articles[i].hop1), hop1.map((n) => n.id));
    for (let j = 0; j < hop1.length; j++) {
      assert.deepEqual(
        idsOf(data.articles[i].hop1[j].hop2),
        refRelated(ARTICLES, EDGES, hop1[j].id, 1, 1).map((n) => n.id),
      );
    }
  }
});

test('id is exposed as GraphQL ID (string) and rank as Int', async () => {
  const cms = freshCms();
  const data = (await run(cms, `{ articles(offset: 0, limit: 1) { id rank } }`)) as {
    articles: Array<{ id: unknown; rank: unknown }>;
  };
  assert.equal(typeof data.articles[0].id, 'string');
  assert.equal(typeof data.articles[0].rank, 'number');
});
