import assert from 'node:assert/strict';
import test from 'node:test';
import { build, type Page, type SynonymEdge } from '../src/index.js';
import { referenceSearch } from './reference.js';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('低权重直达边胜不过多跳路径', () => {
  // a -1000-> c -900-> b 得 900；a -100-> b 直达只有 100
  const pages: Page[] = [{ id: 1, title: ['b'], body: [], tags: [], author: [] }];
  const synonyms: SynonymEdge[] = [
    { from: 'a', to: 'b', w: 100 },
    { from: 'a', to: 'c', w: 1000 },
    { from: 'c', to: 'b', w: 900 },
  ];
  const searcher = build(pages, synonyms);
  assert.deepEqual(searcher.search(['a'], 10), [{ id: 1, score: 900 * 8 }]);
});

test('权重1000的环可终止且置信度不增', () => {
  const pages: Page[] = [{ id: 1, title: [], body: ['b'], tags: [], author: [] }];
  const synonyms: SynonymEdge[] = [
    { from: 'a', to: 'b', w: 1000 },
    { from: 'b', to: 'a', w: 1000 },
    { from: 'b', to: 'c', w: 1000 },
    { from: 'c', to: 'b', w: 500 },
  ];
  const searcher = build(pages, synonyms);
  assert.deepEqual(searcher.search(['a'], 10), [{ id: 1, score: 1000 }]);
});

test('多个纠错起点汇合取最大置信度', () => {
  // 查询词 "cat"：纠错起点 bat(600) 与 cut(600)；
  // bat -1000-> dog(600)，cut -500-> dog(300)，汇合后 dog 取 600
  const pages: Page[] = [{ id: 7, title: [], body: [], tags: ['dog'], author: [] }];
  const synonyms: SynonymEdge[] = [
    { from: 'bat', to: 'dog', w: 1000 },
    { from: 'cut', to: 'dog', w: 500 },
  ];
  const searcher = build(pages, synonyms);
  assert.deepEqual(searcher.search(['cat'], 10), [{ id: 7, score: 600 * 4 }]);
});

test('非BMP字符的插入与替换', () => {
  const smile = '😀'; // U+1F600，单码点
  const pages: Page[] = [
    { id: 1, title: [`a${smile}b`], body: [], tags: [], author: [] }, // 插入 😀
    { id: 2, title: [`a🚀b`], body: [], tags: [], author: [] }, // 替换 😀->🚀
    { id: 3, title: [`a${smile}${smile}${smile}b`], body: [], tags: [], author: [] }, // 距离 2，不命中
  ];
  const searcher = build(pages, []);
  const res = searcher.search([`a${smile}b`], 10);
  // 页面1精确命中 1000*8；页面2是替换邻居 600*8；页面3距离为2不命中
  assert.deepEqual(res, [
    { id: 1, score: 8000 },
    { id: 2, score: 4800 },
  ]);
});

test('跨字段不重复计分，取最大字段权重', () => {
  const pages: Page[] = [
    { id: 1, title: ['x'], body: ['x'], tags: ['x'], author: ['x'] },
  ];
  const searcher = build(pages, []);
  assert.deepEqual(searcher.search(['x'], 10), [{ id: 1, score: 1000 * 8 }]);
});

test('必须命中每个查询词元', () => {
  const pages: Page[] = [
    { id: 1, title: ['alpha'], body: [], tags: [], author: [] },
    { id: 2, title: ['alpha'], body: ['beta'], tags: [], author: [] },
  ];
  const searcher = build(pages, []);
  assert.deepEqual(searcher.search(['alpha', 'beta'], 10), [
    { id: 2, score: 1000 * 8 + 1000 },
  ]);
});

test('重复查询词元去重', () => {
  const pages: Page[] = [{ id: 1, title: ['x'], body: [], tags: [], author: [] }];
  const searcher = build(pages, []);
  assert.deepEqual(searcher.search(['x', 'x', 'x'], 10), [{ id: 1, score: 8000 }]);
});

test('同分按 id 升序', () => {
  const pages: Page[] = [
    { id: 9, title: ['x'], body: [], tags: [], author: [] },
    { id: 3, title: ['x'], body: [], tags: [], author: [] },
    { id: 5, title: ['x'], body: [], tags: [], author: [] },
  ];
  const searcher = build(pages, []);
  assert.deepEqual(searcher.search(['x'], 2), [
    { id: 3, score: 8000 },
    { id: 5, score: 8000 },
  ]);
});

test('随机语料与全量参考一致', () => {
  for (let seed = 1; seed <= 12; seed++) {
    const rand = mulberry32(seed);
    const alphabet = ['a', 'b', 'c', '😀', '🚀'];
    const mkToken = (): string => {
      const len = 1 + Math.floor(rand() * 4);
      let s = '';
      for (let i = 0; i < len; i++) s += alphabet[Math.floor(rand() * alphabet.length)];
      return s;
    };
    const vocabPool = new Set<string>();
    while (vocabPool.size < 40) vocabPool.add(mkToken());
    const vocab = [...vocabPool];

    const pages: Page[] = [];
    const pageCount = 30 + Math.floor(rand() * 60);
    for (let i = 0; i < pageCount; i++) {
      const mkField = (max: number): string[] => {
        const n = Math.floor(rand() * max);
        const out: string[] = [];
        for (let j = 0; j < n; j++) out.push(vocab[Math.floor(rand() * vocab.length)]!);
        return out;
      };
      pages.push({
        id: 1000 + Math.floor(rand() * 100000),
        title: mkField(3),
        body: mkField(8),
        tags: mkField(4),
        author: mkField(2),
      });
    }
    // id 唯一化
    const ids = new Set<number>();
    for (const p of pages) {
      while (ids.has(p.id)) p.id += 1;
      ids.add(p.id);
    }

    const synonyms: SynonymEdge[] = [];
    const edgeCount = Math.floor(rand() * 60);
    for (let i = 0; i < edgeCount; i++) {
      synonyms.push({
        from: vocab[Math.floor(rand() * vocab.length)]!,
        to: vocab[Math.floor(rand() * vocab.length)]!,
        w: Math.floor(rand() * 1001),
      });
    }

    const searcher = build(pages, synonyms);
    for (let q = 0; q < 30; q++) {
      const qlen = 1 + Math.floor(rand() * 4);
      const query: string[] = [];
      for (let j = 0; j < qlen; j++) {
        // 一半从词表取，一半随机生成（可能触发纠错或无命中）
        query.push(rand() < 0.5 ? vocab[Math.floor(rand() * vocab.length)]! : mkToken());
      }
      const k = 1 + Math.floor(rand() * 20);
      const expected = referenceSearch(pages, synonyms, query, k);
      const actual = searcher.search(query, k);
      assert.deepEqual(
        actual,
        expected,
        `seed=${seed} query=${JSON.stringify(query)} k=${k}`,
      );
    }
  }
});
