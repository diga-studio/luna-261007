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

// 场景一：同一用户错时加入共享计算，各自按自己的截止点降级，
// 随后迟到成功使后续查询命中新缓存。
test('错时加入共享一次计算，先到期的查询降级，迟到成功更新缓存', async () => {
  const clock = new FakeClock();
  const computer = new TestComputer();
  const cache = new RecommendationCache<string>({
    compute: computer.compute,
    initialVersion: 1,
    clock,
  });

  // t=0：查询 A 进入，发起该用户该版本唯一一次计算，截止点 t=5000
  const resultA = cache.query('u1');
  await flush();
  assert.equal(computer.count, 1);
  assert.deepEqual(
    { userId: computer.calls[0].userId, version: computer.calls[0].version },
    { userId: 'u1', version: 1 },
  );

  // t=2000：查询 B 加入，共享同一次计算（不发起新计算），截止点 t=7000
  await advanceAndFlush(clock, 2000);
  const resultB = cache.query('u1');
  await flush();
  assert.equal(computer.count, 1, '同一用户同一版本只能共享一次计算');

  // t=5000：A 的预算耗尽，无缓存可降级 -> 暂不可用
  await advanceAndFlush(clock, 3000);
  assert.deepEqual(await resultA, { status: 'unavailable' } satisfies QueryResult<string>);

  // t=6000：计算迟到成功。A 已结束不受影响；B 的截止点是 7000，拿到正常计算结果
  await advanceAndFlush(clock, 1000);
  computer.last().resolve(items('u1', 1));
  await flush();
  assert.deepEqual(await resultB, {
    status: 'computed',
    items: items('u1', 1),
  } satisfies QueryResult<string>);

  // 迟到成功已更新缓存：后续查询直接命中新鲜缓存，不再发起计算
  const resultC = await cache.query('u1');
  assert.deepEqual(resultC, {
    status: 'fresh',
    items: items('u1', 1),
  } satisfies QueryResult<string>);
  assert.equal(computer.count, 1, '命中新鲜缓存不得再发起计算');
});
