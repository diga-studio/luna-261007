import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {
  RollingRelease,
  FAILURE_COOLDOWN_MS,
  MAX_ATTEMPTS,
  REDISPATCH_AFTER_MS,
} from '../src/release.js';
import type { Instruction } from '../src/types.js';

class Clock {
  now = 1_700_000_000_000;
  advance(ms: number): void {
    this.now += ms;
  }
}

const endpoints = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => `ep${String(i + 1).padStart(2, '0')}`);

test('创建计划：目标去重、上限为10%向下取整且最少1、同时只允许一个活动计划', () => {
  const release = new RollingRelease(':memory:');
  const clock = new Clock();
  void clock;

  assert.throws(() => release.createPlan({ planId: 'p0', patchId: 'patch', endpointIds: [] }));

  const withDupes = [...endpoints(21), 'ep01', 'ep07', 'ep01'];
  release.createPlan({ planId: 'p1', patchId: 'patch-a', endpointIds: withDupes });
  let progress = release.progress();
  assert.equal(progress.total, 21);
  assert.equal(progress.inflightCap, 2);
  assert.equal(progress.active, true);

  assert.throws(() =>
    release.createPlan({ planId: 'p2', patchId: 'patch-b', endpointIds: endpoints(3) }),
  );

  const small = new RollingRelease(':memory:');
  small.createPlan({ planId: 's1', patchId: 'patch', endpointIds: endpoints(5) });
  assert.equal(small.progress().inflightCap, 1);
  small.close();

  release.close();
});

test('领取即占用名额；30秒去重窗口后原标识重投，次数与名额不变', () => {
  const release = new RollingRelease(':memory:');
  const clock = new Clock();
  release.createPlan({ planId: 'p1', patchId: 'patch-a', endpointIds: endpoints(10) });

  const first = release.claim(clock.now);
  assert.equal(first.length, 1);
  assert.equal(first[0]!.redispatch, false);
  assert.equal(first[0]!.attemptNo, 1);
  assert.equal(release.progress().inflight, 1);

  assert.deepEqual(release.claim(clock.now), []);

  clock.advance(REDISPATCH_AFTER_MS - 1);
  assert.deepEqual(release.claim(clock.now), []);

  clock.advance(1);
  const second = release.claim(clock.now);
  assert.equal(second.length, 1);
  assert.equal(second[0]!.redispatch, true);
  assert.equal(second[0]!.attemptId, first[0]!.attemptId);
  assert.equal(second[0]!.attemptNo, 1);
  assert.equal(release.progress().inflight, 1);

  // 重投后重新计算30秒窗口。
  clock.advance(REDISPATCH_AFTER_MS - 1);
  assert.deepEqual(release.claim(clock.now), []);

  // 终态释放名额，下一个端点可派发。
  clock.advance(1);
  assert.equal(release.feedback(first[0]!.attemptId, 'succeeded', clock.now).accepted, true);
  assert.equal(release.progress().inflight, 0);
  const third = release.claim(clock.now);
  assert.equal(third.length, 1);
  assert.notEqual(third[0]!.attemptId, first[0]!.attemptId);
  assert.equal(third[0]!.endpointId, 'ep02');

  release.close();
});

test('进度反馈单调推进：不能从安装中退回下载中，重复进度被忽略', () => {
  const release = new RollingRelease(':memory:');
  const clock = new Clock();
  release.createPlan({ planId: 'p1', patchId: 'patch-a', endpointIds: endpoints(5) });

  const [ins] = release.claim(clock.now);
  assert.equal(release.feedback(ins!.attemptId, 'downloading', clock.now).accepted, true);
  assert.equal(release.feedback(ins!.attemptId, 'installing', clock.now).accepted, true);

  const regress = release.feedback(ins!.attemptId, 'downloading', clock.now);
  assert.equal(regress.accepted, false);
  const duplicate = release.feedback(ins!.attemptId, 'installing', clock.now);
  assert.equal(duplicate.accepted, false);

  assert.equal(release.feedback(ins!.attemptId, 'succeeded', clock.now).accepted, true);
  const afterTerminal = release.feedback(ins!.attemptId, 'failed', clock.now);
  assert.equal(afterTerminal.accepted, false);

  assert.throws(() => release.feedback('no-such-attempt', 'failed', clock.now));
  release.close();
});

test('重复失败反馈跨越15分钟边界：首个失败固定冷却，到期时刻即可派发', () => {
  const release = new RollingRelease(':memory:');
  const clock = new Clock();
  release.createPlan({ planId: 'p1', patchId: 'patch-a', endpointIds: ['ep1'] });

  const t0 = clock.now;
  const [ins1] = release.claim(t0);
  assert.equal(release.feedback(ins1!.attemptId, 'failed', t0).accepted, true);
  assert.equal(
    release.progress().endpoints[0]!.cooldownUntil,
    t0 + FAILURE_COOLDOWN_MS,
  );

  // 冷却期内的重复失败反馈被忽略，且不推迟冷却期限。
  clock.advance(10 * 60_000);
  const dup = release.feedback(ins1!.attemptId, 'failed', clock.now);
  assert.equal(dup.accepted, false);
  clock.advance(4 * 60_000);
  const dup2 = release.feedback(ins1!.attemptId, 'failed', clock.now);
  assert.equal(dup2.accepted, false);
  assert.equal(
    release.progress().endpoints[0]!.cooldownUntil,
    t0 + FAILURE_COOLDOWN_MS,
  );

  // 到期前1毫秒不可派发。
  clock.advance(59_999);
  assert.equal(clock.now, t0 + FAILURE_COOLDOWN_MS - 1);
  assert.deepEqual(release.claim(clock.now), []);

  // 等于到期时刻即可派发：新尝试、次数+1。
  clock.advance(1);
  const [ins2] = release.claim(clock.now);
  assert.equal(ins2!.attemptNo, 2);
  assert.notEqual(ins2!.attemptId, ins1!.attemptId);
  assert.equal(ins2!.redispatch, false);

  assert.equal(release.feedback(ins2!.attemptId, 'succeeded', clock.now).accepted, true);
  assert.equal(release.progress().active, false);
  release.close();
});

test('旧尝试的迟到反馈不改变新尝试状态、不释放其名额', () => {
  const release = new RollingRelease(':memory:');
  const clock = new Clock();
  release.createPlan({ planId: 'p1', patchId: 'patch-a', endpointIds: ['ep1'] });

  const t0 = clock.now;
  const [ins1] = release.claim(t0);
  release.feedback(ins1!.attemptId, 'failed', t0);

  clock.advance(FAILURE_COOLDOWN_MS);
  const [ins2] = release.claim(clock.now);
  assert.equal(ins2!.attemptNo, 2);

  // 旧尝试的迟到终态与进度反馈都被拒绝。
  const lateTerminal = release.feedback(ins1!.attemptId, 'succeeded', clock.now);
  assert.equal(lateTerminal.accepted, false);
  const lateProgress = release.feedback(ins1!.attemptId, 'installing', clock.now);
  assert.equal(lateProgress.accepted, false);

  // 新尝试状态与名额不受影响。
  const ep = release.progress().endpoints[0]!;
  assert.equal(ep.state, 'in_flight');
  assert.equal(ep.currentAttemptId, ins2!.attemptId);
  assert.equal(release.progress().inflight, 1);
  clock.advance(1);
  assert.deepEqual(release.claim(clock.now), []);

  // 新尝试自身仍可正常推进到终态。
  assert.equal(release.feedback(ins2!.attemptId, 'installing', clock.now).accepted, true);
  assert.equal(release.feedback(ins2!.attemptId, 'succeeded', clock.now).accepted, true);
  assert.equal(release.progress().active, false);
  release.close();
});

test('冷却不占名额：有可派发目标时补满空闲名额，不被冷却端点阻塞', () => {
  const release = new RollingRelease(':memory:');
  const clock = new Clock();
  release.createPlan({ planId: 'p1', patchId: 'patch-a', endpointIds: endpoints(20) });

  const t0 = clock.now;
  const first = release.claim(t0);
  assert.equal(first.length, 2);
  release.feedback(first[0]!.attemptId, 'failed', t0);

  // 失败释放的名额立即补给下一个端点。
  const second = release.claim(clock.now);
  assert.equal(second.length, 1);
  assert.equal(second[0]!.endpointId, 'ep03');
  assert.equal(release.progress().inflight, 2);

  // 其余在途尝试成功，冷却中的 ep01 不阻塞后续派发。
  release.feedback(first[1]!.attemptId, 'succeeded', clock.now);
  release.feedback(second[0]!.attemptId, 'succeeded', clock.now);
  clock.advance(FAILURE_COOLDOWN_MS - 1);
  const third = release.claim(clock.now);
  assert.equal(third.length, 2);
  assert.ok(third.every((ins) => ins.endpointId !== 'ep01'));

  // 冷却到期（等于到期时刻）后 ep01 以第2次尝试派发。
  clock.advance(1);
  release.feedback(third[0]!.attemptId, 'succeeded', clock.now);
  release.feedback(third[1]!.attemptId, 'succeeded', clock.now);
  const fourth = release.claim(clock.now);
  const retry = fourth.find((ins) => ins.endpointId === 'ep01');
  assert.ok(retry);
  assert.equal(retry!.attemptNo, 2);

  release.close();
});

test('第4次失败结束端点发布：每端点最多4次有效尝试', () => {
  const release = new RollingRelease(':memory:');
  const clock = new Clock();
  release.createPlan({ planId: 'p1', patchId: 'patch-a', endpointIds: ['ep1'] });

  const attemptIds: string[] = [];
  for (let attemptNo = 1; attemptNo <= MAX_ATTEMPTS; attemptNo += 1) {
    const [ins] = release.claim(clock.now);
    assert.equal(ins!.attemptNo, attemptNo);
    attemptIds.push(ins!.attemptId);
    assert.equal(release.feedback(ins!.attemptId, 'failed', clock.now).accepted, true);
    if (attemptNo < MAX_ATTEMPTS) {
      assert.equal(release.progress().endpoints[0]!.state, 'cooldown');
      clock.advance(FAILURE_COOLDOWN_MS);
    }
  }
  assert.equal(new Set(attemptIds).size, MAX_ATTEMPTS);

  const progress = release.progress();
  assert.equal(progress.endpoints[0]!.state, 'failed');
  assert.equal(progress.endpoints[0]!.attemptCount, MAX_ATTEMPTS);
  assert.equal(progress.active, false);
  assert.deepEqual(release.claim(clock.now), []);
  release.close();
});

test('全量滚动发布：在途不超上限、重投标识不变、全部推进到终态', () => {
  const release = new RollingRelease(':memory:');
  const clock = new Clock();
  const targets = endpoints(25);
  release.createPlan({ planId: 'p1', patchId: 'patch-a', endpointIds: targets });
  const cap = release.progress().inflightCap;
  assert.equal(cap, 2);

  const failFirst = new Set(['ep03', 'ep06', 'ep12', 'ep15', 'ep18', 'ep21', 'ep24']);
  const holdForRedispatch = new Set(['ep05', 'ep13']);
  const rolledBackFirst = new Set(['ep07']);
  const alwaysFail = new Set(['ep09']);

  const held = new Map<string, Instruction>();
  const attemptIdsByEndpoint = new Map<string, string[]>();
  let redispatchCount = 0;

  const respond = (ins: Instruction): void => {
    if (rolledBackFirst.has(ins.endpointId) && ins.attemptNo === 1) {
      release.feedback(ins.attemptId, 'rolled_back', clock.now);
      return;
    }
    if (alwaysFail.has(ins.endpointId)) {
      release.feedback(ins.attemptId, 'failed', clock.now);
      return;
    }
    if (failFirst.has(ins.endpointId) && ins.attemptNo === 1) {
      release.feedback(ins.attemptId, 'failed', clock.now);
      return;
    }
    release.feedback(ins.attemptId, 'downloading', clock.now);
    release.feedback(ins.attemptId, 'installing', clock.now);
    release.feedback(ins.attemptId, 'succeeded', clock.now);
  };

  let guard = 0;
  while (release.progress().active) {
    assert.ok(guard < 2000, 'rollout must terminate');
    guard += 1;

    const instructions = release.claim(clock.now);
    assert.ok(release.progress().inflight <= cap, 'inflight must never exceed cap');

    for (const ins of instructions) {
      if (ins.redispatch) {
        const original = held.get(ins.attemptId);
        assert.ok(original, 'redispatch must reference a previously claimed attempt');
        assert.equal(ins.attemptNo, original!.attemptNo);
        redispatchCount += 1;
        respond(ins);
        held.delete(ins.attemptId);
        continue;
      }
      const ids = attemptIdsByEndpoint.get(ins.endpointId) ?? [];
      assert.ok(!ids.includes(ins.attemptId), 'attempt id must never be reused');
      ids.push(ins.attemptId);
      attemptIdsByEndpoint.set(ins.endpointId, ids);
      assert.ok(ids.length <= MAX_ATTEMPTS, 'endpoint must have at most 4 effective attempts');

      if (holdForRedispatch.has(ins.endpointId) && ins.attemptNo === 1 && !held.has(ins.attemptId)) {
        held.set(ins.attemptId, ins);
        continue;
      }
      respond(ins);
    }
    assert.ok(release.progress().inflight <= cap);
    clock.advance(REDISPATCH_AFTER_MS);
  }

  assert.ok(redispatchCount >= 2, 'redispatch path must be exercised');
  assert.equal(held.size, 0);

  const progress = release.progress();
  assert.equal(progress.inflight, 0);
  assert.equal(progress.failed, 1);
  assert.equal(progress.rolledBack, 1);
  assert.equal(progress.succeeded, 23);
  for (const ep of progress.endpoints) {
    assert.ok(ep.attemptCount <= MAX_ATTEMPTS);
    if (ep.endpointId === 'ep09') {
      assert.equal(ep.state, 'failed');
      assert.equal(ep.attemptCount, MAX_ATTEMPTS);
    } else if (ep.endpointId === 'ep07') {
      assert.equal(ep.state, 'rolled_back');
    } else {
      assert.equal(ep.state, 'succeeded');
    }
  }
  release.close();
});

test('发布状态持久化到SQLite：重开后可继续领取与反馈', () => {
  const dbPath = path.join(os.tmpdir(), `rolling-release-${process.pid}.db`);
  fs.rmSync(dbPath, { force: true });
  const clock = new Clock();

  const first = new RollingRelease(dbPath);
  first.createPlan({ planId: 'p1', patchId: 'patch-a', endpointIds: endpoints(5) });
  const [ins] = first.claim(clock.now);
  first.feedback(ins!.attemptId, 'downloading', clock.now);
  first.close();

  const second = new RollingRelease(dbPath);
  const progress = second.progress();
  assert.equal(progress.inflight, 1);
  assert.equal(progress.endpoints[0]!.state, 'in_flight');
  assert.equal(second.feedback(ins!.attemptId, 'installing', clock.now).accepted, true);

  clock.advance(REDISPATCH_AFTER_MS);
  const redispatched = second.claim(clock.now);
  assert.equal(redispatched[0]!.attemptId, ins!.attemptId);
  assert.equal(redispatched[0]!.redispatch, true);
  second.close();

  fs.rmSync(dbPath, { force: true });
});
