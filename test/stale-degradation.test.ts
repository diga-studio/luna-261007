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

// 场景三：缓存恰好到期后计算失败，有缓存的用户得到陈旧降级，
// 无缓存的用户得到暂不可用，其他用户仍正常完成。
test('缓存到期后计算失败：陈旧降级 / 暂不可用 / 其他用户正常', async () => {
  const clock = new FakeClock();
  const computer = new TestComputer();
  const cache = new RecommendationCache<string>({
    compute: computer.compute,
    initialVersion: 1,
    clock,
  });

  // t=0：u1 查询，t=1000 计算成功，缓存从 t=1000 起计 600000ms 新鲜期
  const warmup = cache.query('u1');
  await flush();
  await advanceAndFlush(clock, 1000);
  computer.last().resolve(items('u1', 1));
  await flush();
  assert.deepEqual(await warmup, { status: 'computed', items: items('u1', 1) });

  // 推进到 t=601000：缓存恰好满 600000ms，成为陈旧缓存
  await advanceAndFlush(clock, 600_000);

  // u1（有陈旧缓存）、u2（无缓存）、u3（无缓存）同时未命中，各自独立发起计算
  const resultA = cache.query('u1');
  const resultB = cache.query('u2');
  const resultC = cache.query('u3');
  await flush();
  assert.equal(computer.count, 4, '不同用户独立计算，互不影响');
  const [, failU1, failU2, okU3] = computer.calls;

  // t=602000：u1、u2 的计算失败（在各自预算内）
  await advanceAndFlush(clock, 1000);
  failU1.reject(new Error('compute failed'));
  failU2.reject(new Error('compute failed'));
  await flush();

  // u1 得到陈旧降级（恰好到期的缓存仍可用于降级），u2 得到暂不可用
  assert.deepEqual(await resultA, {
    status: 'stale',
    items: items('u1', 1),
  } satisfies QueryResult<string>);
  assert.deepEqual(await resultB, { status: 'unavailable' } satisfies QueryResult<string>);

  // t=603000：u3 的计算正常完成，不受其他用户失败影响
  await advanceAndFlush(clock, 1000);
  okU3.resolve(items('u3', 1));
  await flush();
  assert.deepEqual(await resultC, {
    status: 'computed',
    items: items('u3', 1),
  } satisfies QueryResult<string>);

  // 失败没有清掉 u1 的缓存，后续查询能重新发起计算；
  // 新计算在预算内不结束时，仍按自己的截止点降级到同一份陈旧缓存
  const retry = cache.query('u1');
  await flush();
  assert.equal(computer.count, 5, '失败后应能重新发起计算');
  await advanceAndFlush(clock, 5000); // 越过 retry 的截止点
  assert.deepEqual(await retry, {
    status: 'stale',
    items: items('u1', 1),
  } satisfies QueryResult<string>);
});
