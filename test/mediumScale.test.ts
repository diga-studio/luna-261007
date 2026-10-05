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

/** 中等规模（2000 页 / 2000 词 / 3000 边）与全量参考逐查询核对。 */
test('中等规模随机语料与全量参考一致', { timeout: 120000 }, () => {
  const rand = mulberry32(42);
  const letters = 'abcdef';
  const emoji = ['😀', '🚀'];
  const vocab: string[] = [];
  const seen = new Set<string>();
  while (vocab.length < 2000) {
    const len = 2 + Math.floor(rand() * 6);
    let w = '';
    for (let i = 0; i < len; i++) {
      w += rand() < 0.05 ? emoji[Math.floor(rand() * 2)] : letters[Math.floor(rand() * 6)];
    }
    if (!seen.has(w)) {
      seen.add(w);
      vocab.push(w);
    }
  }

  const pages: Page[] = [];
  for (let i = 0; i < 2000; i++) {
    const mkField = (max: number): string[] => {
      const n = Math.floor(rand() * max);
      const out: string[] = [];
      for (let j = 0; j < n; j++) out.push(vocab[Math.floor(rand() * vocab.length)]!);
      return out;
    };
    pages.push({
      id: 10_000 + i,
      title: mkField(4),
      body: mkField(20),
      tags: mkField(6),
      author: mkField(3),
    });
  }

  const synonyms: SynonymEdge[] = [];
  for (let i = 0; i < 3000; i++) {
    synonyms.push({
      from: vocab[Math.floor(rand() * vocab.length)]!,
      to: vocab[Math.floor(rand() * vocab.length)]!,
      w: Math.floor(rand() * 1001),
    });
  }

  const searcher = build(pages, synonyms);
  for (let q = 0; q < 100; q++) {
    const qlen = 1 + Math.floor(rand() * 4);
    const query: string[] = [];
    for (let j = 0; j < qlen; j++) {
      if (rand() < 0.6) {
        query.push(vocab[Math.floor(rand() * vocab.length)]!);
      } else {
        // 随机词，可能触发纠错
        const len = 2 + Math.floor(rand() * 5);
        let w = '';
        for (let c = 0; c < len; c++) w += letters[Math.floor(rand() * 6)];
        query.push(w);
      }
    }
    const k = 1 + Math.floor(rand() * 20);
    const expected = referenceSearch(pages, synonyms, query, k);
    const actual = searcher.search(query, k);
    assert.deepEqual(actual, expected, `query=${JSON.stringify(query)} k=${k}`);
  }
});
