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

function tracked(p: Promise<QueryResult<string>>) {
  const state = { settled: false, promise: null as Promise<QueryResult<string>> | null };
  state.promise = p.then((r) => {
    state.settled = true;
    return r;
  });
  return state;
}

// 场景二：等待期间连续切换版本，旧计算乱序成功或失败，
// 最终缓存及未结束查询只能使用最新版本，且等待预算不重置。
test('连续切换版本：旧计算乱序结束不污染新版本，等待预算不重置', async () => {
  const clock = new FakeClock();
  const computer = new TestComputer();
  const cache = new RecommendationCache<string>({
    compute: computer.compute,
    initialVersion: 1,
    clock,
  });

  // t=0：u1 的查询 A、u2 的查询 B 进入，各自发起 v1 计算，截止点都是 t=5000
  const a = tracked(cache.query('u1'));
  const b = tracked(cache.query('u2'));
  await flush();
  assert.equal(computer.count, 2);

  // t=1000：切换到 v2，等待中的查询在剩余预算内改等 v2，立即发起新计算
  await advanceAndFlush(clock, 1000);
  cache.setVersion(2);
  await flush();
  assert.equal(computer.count, 4, '切换版本后应为两个用户立即发起 v2 计算');
  assert.deepEqual(
    [computer.calls[2].version, computer.calls[3].version],
    [2, 2],
  );

  // t=2000：再切换到 v3
  await advanceAndFlush(clock, 1000);
  cache.setVersion(3);
  await flush();
  assert.equal(computer.count, 6);
  const [c1u1, c1u2, c2u1, , c3u1, c3u2] = computer.calls;
  assert.deepEqual(
    computer.calls.map((c) => [c.userId, c.version]),
    [['u1', 1], ['u2', 1], ['u1', 2], ['u2', 2], ['u1', 3], ['u2', 3]],
  );

  // t=2500：v1 旧计算迟到成功（乱序），不得更新缓存、不得结束任何等待者
  await advanceAndFlush(clock, 500);
  c1u1.resolve(items('u1', 1));
  await flush();
  assert.equal(a.settled, false, '旧版本成功不得结束等待者');

  // t=2600：新查询 D 进入，若缓存被 v1 污染会命中 fresh；实际应加入 v3 计算
  await advanceAndFlush(clock, 100);
  const d = tracked(cache.query('u1'));
  await flush();
  assert.equal(computer.count, 6, '旧版本成功不得污染缓存，D 应共享 v3 计算');
  assert.equal(d.settled, false);

  // t=3000：v2 旧计算迟到失败（乱序），不得影响等待者
  await advanceAndFlush(clock, 400);
  c2u1.reject(new Error('stale failure'));
  await flush();
  assert.equal(a.settled, false, '旧版本失败不得影响等待者');
  assert.equal(d.settled, false);

  // t=4000：v3 计算成功，A（截止点 5000）和 D 都拿到最新版本的正常结果
  await advanceAndFlush(clock, 1000);
  c3u1.resolve(items('u1', 3));
  await flush();
  assert.deepEqual(await a.promise, { status: 'computed', items: items('u1', 3) });
  assert.deepEqual(await d.promise, { status: 'computed', items: items('u1', 3) });

  // 缓存属于 v3：新查询命中新鲜缓存
  assert.deepEqual(await cache.query('u1'), {
    status: 'fresh',
    items: items('u1', 3),
  } satisfies QueryResult<string>);

  // u2 的 v3 计算始终不结束：B 按原截止点 t=5000 降级（预算没有因两次切版本重置）
  await advanceAndFlush(clock, 1000); // t=5000
  assert.equal(b.settled, true, 'B 应在原截止点 t=5000 降级，而非延长预算');
  assert.deepEqual(await b.promise, { status: 'unavailable' } satisfies QueryResult<string>);

  // t=5500：u2 的 v3 计算迟到成功，仍可更新同版本缓存
  await advanceAndFlush(clock, 500);
  c3u2.resolve(items('u2', 3));
  await flush();
  assert.deepEqual(await cache.query('u2'), {
    status: 'fresh',
    items: items('u2', 3),
  } satisfies QueryResult<string>);

  // 旧版本计算再乱序结束（u2 的 v1 成功）也不能覆盖新缓存
  c1u2.resolve(items('u2', 1));
  await flush();
  assert.deepEqual(await cache.query('u2'), {
    status: 'fresh',
    items: items('u2', 3),
  } satisfies QueryResult<string>);
});
