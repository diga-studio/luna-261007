import assert from 'node:assert/strict';
import test from 'node:test';
import type { StaticData } from '../src/index.ts';
import { cleanup, makeService } from './helpers.ts';

const data: StaticData = {
  employees: [
    { id: 'e1', qualifications: ['a'] },
    { id: 'e2', qualifications: ['a'] },
  ],
  shifts: [],
  gaps: [{ id: 'g1', startMin: 1000, endMin: 1100, requiredQualifications: ['a'] }],
};

test('截止后重新指派：旧接受与旧取消到达不影响新邀约', () => {
  const { service, dir } = makeService(data);
  try {
    // 主管 A 在 t=0 邀 e1
    const old = service.invite({ key: 'old', gapId: 'g1', employeeId: 'e1', nowMin: 0 });
    assert.equal(old.ok, true);
    if (!old.ok) return;
    // t=120 旧邀约过期，主管 B 重新指派 e2
    const fresh = service.invite({ key: 'fresh', gapId: 'g1', employeeId: 'e2', nowMin: 120 });
    assert.equal(fresh.ok, true);
    if (!fresh.ok) return;
    // 旧邀约的迟到接受：失败，且不影响新邀约
    const lateAccept = service.respond({
      key: 'late-accept', invitationId: old.invitationId, accept: true, nowMin: 121,
    });
    assert.deepEqual(lateAccept, { ok: false, reason: 'expired' });
    // 旧邀约的迟到取消：允许（幂等终止），不影响新邀约
    const lateCancel = service.cancel({
      key: 'late-cancel', invitationId: old.invitationId, nowMin: 122,
    });
    assert.deepEqual(lateCancel, { ok: true });
    // 新邀约仍占用空缺
    assert.deepEqual(service.getCandidates('g1', 122), []);
    // 新邀约接受成功
    const accept = service.respond({
      key: 'accept-fresh', invitationId: fresh.invitationId, accept: true, nowMin: 130,
    });
    assert.deepEqual(accept, { ok: true });
    // 旧邀约不会因任何操作复活
    const revive = service.respond({
      key: 'revive', invitationId: old.invitationId, accept: true, nowMin: 131,
    });
    assert.deepEqual(revive, { ok: false, reason: 'not_respondable' });
    assert.deepEqual(service.getCandidates('g1', 200), []);
  } finally {
    service.close();
    cleanup(dir);
  }
});

test('多个主管争抢同一员工：后到者因重叠失败', () => {
  const twoGaps: StaticData = {
    employees: [{ id: 'e1', qualifications: ['a'] }],
    shifts: [],
    gaps: [
      { id: 'g1', startMin: 1000, endMin: 1100, requiredQualifications: ['a'] },
      { id: 'g2', startMin: 1050, endMin: 1150, requiredQualifications: ['a'] },
    ],
  };
  const { service, dir } = makeService(twoGaps);
  try {
    const r1 = service.invite({ key: 'k1', gapId: 'g1', employeeId: 'e1', nowMin: 0 });
    assert.equal(r1.ok, true);
    // 同一员工在重叠区间上的另一个空缺：候选为空，发起失败
    assert.deepEqual(service.getCandidates('g2', 0), []);
    const r2 = service.invite({ key: 'k2', gapId: 'g2', employeeId: 'e1', nowMin: 0 });
    assert.deepEqual(r2, { ok: false, reason: 'overlap' });
  } finally {
    service.close();
    cleanup(dir);
  }
});

test('多个主管争抢同一空缺：只有第一个成功', () => {
  const { service, dir } = makeService(data);
  try {
    const r1 = service.invite({ key: 'k1', gapId: 'g1', employeeId: 'e1', nowMin: 0 });
    const r2 = service.invite({ key: 'k2', gapId: 'g1', employeeId: 'e2', nowMin: 0 });
    assert.equal(r1.ok, true);
    assert.deepEqual(r2, { ok: false, reason: 'gap_occupied' });
  } finally {
    service.close();
    cleanup(dir);
  }
});
