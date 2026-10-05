import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RecommendationCache } from '../src/index.js';
import type { QueryResult } from '../src/index.js';
import {
  TestComputer,
  FakeClock,
  advanceAndFlush,
  flush,
  items,
} from './helpers.js';

// 非功能：50 个并发查询下同用户共享一次计算；10 个用户并行计算互不排队
test('50 并发：同用户共享一次计算，10 个用户并行不互相排队', async () => {
  const clock = new FakeClock();
  const computer = new TestComputer();
  const cache = new RecommendationCache<string>({
    compute: computer.compute,
    initialVersion: 1,
    clock,
  });

  // 10 个用户各 5 个并发查询（共 50 个），同用户只能共享一次计算
  const pending: Promise<QueryResult<string>>[] = [];
  for (let u = 1; u <= 10; u++) {
    for (let q = 0; q < 5; q++) pending.push(cache.query(`u${u}`));
  }
  await flush();
  assert.equal(computer.count, 10, '每个用户恰好一次计算，共 10 次');

  // u1 的计算永远不结束，其余 9 个用户照常完成，不得排队
  for (const call of computer.calls) {
    if (call.userId !== 'u1') call.resolve(items(call.userId, call.version));
  }
  await flush();
  const results = await Promise.all(
    pending.map((p, i) => {
      const user = `u${Math.floor(i / 5) + 1}`;
      return user === 'u1' ? null : p;
    }),
  );
  for (const [i, r] of results.entries()) {
    if (r === null) continue;
    const user = `u${Math.floor(i / 5) + 1}`;
    assert.deepEqual(r, { status: 'computed', items: items(user, 1) });
  }

  // u1 的 5 个查询在各自截止点降级为暂不可用（无缓存），不等计算器
  await advanceAndFlush(clock, 5000);
  for (let i = 0; i < 5; i++) {
    assert.deepEqual(await pending[i], { status: 'unavailable' } satisfies QueryResult<string>);
  }
});

// 非功能：新鲜缓存命中立即返回（不推进时钟、不发起计算）
test('新鲜缓存命中不依赖任何等待，立即返回', async () => {
  const clock = new FakeClock();
  const computer = new TestComputer();
  const cache = new RecommendationCache<string>({
    compute: computer.compute,
    initialVersion: 1,
    clock,
  });

  const first = cache.query('u1');
  await flush();
  computer.last().resolve(items('u1', 1));
  await flush();
  assert.equal((await first).status, 'computed');

  // 50 个并发查询全部命中新鲜缓存：不推进时钟即已结算，且没有新计算
  const hits = Array.from({ length: 50 }, () => cache.query('u1'));
  await flush();
  for (const hit of hits) {
    assert.deepEqual(await hit, {
      status: 'fresh',
      items: items('u1', 1),
    } satisfies QueryResult<string>);
  }
  assert.equal(computer.count, 1);
});

// 非功能：预算耗尽的交付点恰好是截止点，不继续等待计算器
test('预算耗尽恰好在截止点交付暂不可用', async () => {
  const clock = new FakeClock();
  const computer = new TestComputer();
  const cache = new RecommendationCache<string>({
    compute: computer.compute,
    initialVersion: 1,
    clock,
  });

  let settled = false;
  const result = cache.query('u1').then((r) => {
    settled = true;
    return r;
  });
  await flush();

  // 截止点前 1ms 仍未交付
  await advanceAndFlush(clock, 4999);
  assert.equal(settled, false);

  // 到达截止点立即交付，不再等计算器
  await advanceAndFlush(clock, 1);
  assert.equal(settled, true);
  assert.deepEqual(await result, { status: 'unavailable' } satisfies QueryResult<string>);
});
