import assert from 'node:assert/strict';
import test from 'node:test';
import { build, type Page } from '../src/index.js';
import { referenceSearch } from './reference.js';

/**
 * 高频词 common 与稀有词 rare 的联合查询：
 * 目标页在两个词元各自的单独排名中都位于第 20 名之后，
 * 任何按单词元 top-20 截断候选的做法都会漏掉它们。
 */
test('联合查询目标页在单词元排名20名之外仍精确命中', () => {
  const pages: Page[] = [];
  // 30 页 common 在 title（贡献 8000），25 页 common 在 tags（贡献 4000）
  for (let i = 0; i < 30; i++) {
    pages.push({ id: 1000 + i, title: ['common'], body: [], tags: [], author: [] });
  }
  for (let i = 0; i < 25; i++) {
    pages.push({ id: 2000 + i, title: [], body: [], tags: ['common'], author: [] });
  }
  // 30 页 rare 在 title（贡献 8000），25 页 rare 在 tags（贡献 4000）
  for (let i = 0; i < 30; i++) {
    pages.push({ id: 3000 + i, title: ['rare'], body: [], tags: [], author: [] });
  }
  for (let i = 0; i < 25; i++) {
    pages.push({ id: 4000 + i, title: [], body: [], tags: ['rare'], author: [] });
  }
  // 5 个目标页：common 与 rare 都只出现在 body（各贡献 1000，总分 2000）
  for (let i = 0; i < 5; i++) {
    pages.push({ id: 5000 + i, title: [], body: ['common', 'rare'], tags: [], author: [] });
  }

  const searcher = build(pages, []);

  // 单独查询 common：目标页贡献 1000，排在 55 个更高分页面之后
  const commonOnly = searcher.search(['common'], 20);
  assert.equal(commonOnly.length, 20);
  assert.ok(commonOnly.every((r) => r.id < 5000));
  // 单独查询 rare：同理
  const rareOnly = searcher.search(['rare'], 20);
  assert.ok(rareOnly.every((r) => r.id < 5000));

  // 联合查询：只有目标页同时命中两个词元
  const joint = searcher.search(['common', 'rare'], 20);
  assert.deepEqual(
    joint,
    [5000, 5001, 5002, 5003, 5004].map((id) => ({ id, score: 2000 })),
  );
  // 与全量参考一致
  assert.deepEqual(joint, referenceSearch(pages, [], ['common', 'rare'], 20));
});

test('跨字段重复出现不重复计分（回归）', () => {
  const pages: Page[] = [
    { id: 1, title: ['x'], body: ['x'], tags: [], author: [] },
    { id: 2, title: [], body: ['x'], tags: ['x'], author: ['x'] },
  ];
  const searcher = build(pages, []);
  // 页1：max(8,1)*1000=8000；页2：max(4,2,1)*1000=4000
  assert.deepEqual(searcher.search(['x'], 10), [
    { id: 1, score: 8000 },
    { id: 2, score: 4000 },
  ]);
  assert.deepEqual(searcher.search(['x'], 10), referenceSearch(pages, [], ['x'], 10));
});
