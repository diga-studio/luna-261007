import assert from 'node:assert/strict';
import test from 'node:test';
import { splitByWeek, overlaps, weekOf } from '../src/time.ts';
import { WEEK, baseData, cleanup, makeService } from './helpers.ts';

test('weekOf / splitByWeek 按周切分', () => {
  assert.equal(weekOf(0), 0);
  assert.equal(weekOf(WEEK - 1), 0);
  assert.equal(weekOf(WEEK), 1);
  assert.deepEqual(splitByWeek(0, 60), [{ week: 0, minutes: 60 }]);
  assert.deepEqual(splitByWeek(WEEK - 30, WEEK + 30), [
    { week: 0, minutes: 30 },
    { week: 1, minutes: 30 },
  ]);
  assert.deepEqual(splitByWeek(10, 10), []);
});

test('overlaps 半开区间', () => {
  assert.equal(overlaps(0, 60, 60, 120), false);
  assert.equal(overlaps(0, 61, 60, 120), true);
  assert.equal(overlaps(60, 120, 0, 60), false);
});

test('候选查询：资格、固定排班冲突过滤', () => {
  const { service, dir } = makeService(baseData);
  try {
    // g1 需要 a：e1(有 a 但 0-60 有班，不冲突 120-180)、e2 可；e3 无 a
    assert.deepEqual(service.getCandidates('g1', 0), ['e1', 'e2']);
    // g2 需要 b：e1、e3
    assert.deepEqual(service.getCandidates('g2', 0), ['e1', 'e3']);
    assert.deepEqual(service.getCandidates('missing', 0), []);
  } finally {
    service.close();
    cleanup(dir);
  }
});

test('发起邀约后占用空缺与员工区间', () => {
  const { service, dir } = makeService(baseData);
  try {
    const r = service.invite({ key: 'k1', gapId: 'g1', employeeId: 'e2', nowMin: 0 });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.deadlineMin, 120);
    // 空缺被占用
    assert.deepEqual(service.getCandidates('g1', 0), []);
    // 同一空缺再邀任何人失败
    const r2 = service.invite({ key: 'k2', gapId: 'g1', employeeId: 'e1', nowMin: 0 });
    assert.deepEqual(r2, { ok: false, reason: 'gap_occupied' });
    // 截止后（now == deadline 即过期）占用释放
    assert.deepEqual(service.getCandidates('g1', 120), ['e1', 'e2']);
  } finally {
    service.close();
    cleanup(dir);
  }
});

test('接受/拒绝/取消的状态机', () => {
  const { service, dir } = makeService(baseData);
  try {
    const inv = service.invite({ key: 'k1', gapId: 'g1', employeeId: 'e2', nowMin: 0 });
    assert.equal(inv.ok, true);
    if (!inv.ok) return;
    // 截止时刻答复视为过期
    const late = service.respond({
      key: 'k2', invitationId: inv.invitationId, accept: true, nowMin: 120,
    });
    assert.deepEqual(late, { ok: false, reason: 'expired' });
    // 到期前一刻可以接受
    const ok = service.respond({
      key: 'k3', invitationId: inv.invitationId, accept: true, nowMin: 119,
    });
    assert.deepEqual(ok, { ok: true });
    // 已接受后不再受截止限制，且不能再答复
    const again = service.respond({
      key: 'k4', invitationId: inv.invitationId, accept: false, nowMin: 500,
    });
    assert.deepEqual(again, { ok: false, reason: 'not_respondable' });
    // 已接受可以取消，取消后释放
    const cancel = service.cancel({ key: 'k5', invitationId: inv.invitationId, nowMin: 600 });
    assert.deepEqual(cancel, { ok: true });
    assert.deepEqual(service.getCandidates('g1', 600), ['e1', 'e2']);
    // 取消后不能复活
    const revive = service.respond({
      key: 'k6', invitationId: inv.invitationId, accept: true, nowMin: 601,
    });
    assert.deepEqual(revive, { ok: false, reason: 'not_respondable' });
  } finally {
    service.close();
    cleanup(dir);
  }
});

test('幂等：同键同参返回首次结果，同键不同参拒绝', () => {
  const { service, dir } = makeService(baseData);
  try {
    const first = service.invite({ key: 'k1', gapId: 'g1', employeeId: 'e2', nowMin: 0 });
    // 同键同参（时间不同不参与比较）：返回首次结果，不产生新邀约
    const retry = service.invite({ key: 'k1', gapId: 'g1', employeeId: 'e2', nowMin: 50 });
    assert.deepEqual(retry, first);
    // 同键不同参
    const conflict = service.invite({ key: 'k1', gapId: 'g1', employeeId: 'e1', nowMin: 0 });
    assert.deepEqual(conflict, { ok: false, reason: 'idempotency_key_conflict' });
    // 取消后重试同键：不复活、不延长截止
    if (first.ok) {
      service.cancel({ key: 'k9', invitationId: first.invitationId, nowMin: 10 });
      const retry2 = service.invite({ key: 'k1', gapId: 'g1', employeeId: 'e2', nowMin: 20 });
      assert.deepEqual(retry2, first);
      assert.deepEqual(service.getCandidates('g1', 20), ['e1', 'e2']);
    }
  } finally {
    service.close();
    cleanup(dir);
  }
});
