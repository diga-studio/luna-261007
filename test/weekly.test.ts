import assert from 'node:assert/strict';
import test from 'node:test';
import type { StaticData } from '../src/index.ts';
import { WEEK, cleanup, makeService } from './helpers.ts';

// 跨周空缺：第 0 周末尾 1200 分钟 + 第 1 周开头 1200 分钟
const CROSS_GAP = { startMin: WEEK - 1200, endMin: WEEK + 1200 };

function dataWith(shifts: StaticData['shifts'], gaps: StaticData['gaps']): StaticData {
  return {
    employees: [{ id: 'e1', qualifications: ['a'] }],
    shifts,
    gaps,
  };
}

test('跨周邀约分别顶满两周额度：恰好等于允许', () => {
  // 员工两周各有 1200 分钟固定排班；空缺跨周各落 1200 分钟 → 每周恰好 2400
  const data = dataWith(
    [
      { id: 's1', employeeId: 'e1', startMin: 0, endMin: 1200 },
      { id: 's2', employeeId: 'e1', startMin: WEEK + 1200, endMin: WEEK + 2400 },
    ],
    [{ id: 'g1', ...CROSS_GAP, requiredQualifications: ['a'] }],
  );
  const { service, dir } = makeService(data);
  try {
    assert.deepEqual(service.getCandidates('g1', 0), ['e1']);
    const r = service.invite({ key: 'k1', gapId: 'g1', employeeId: 'e1', nowMin: 0 });
    assert.equal(r.ok, true);
  } finally {
    service.close();
    cleanup(dir);
  }
});

test('跨周邀约仅一周超额即拒绝', () => {
  // 第 1 周固定排班 1201 分钟 → 1201 + 1200 = 2401 > 2400
  const data = dataWith(
    [
      { id: 's1', employeeId: 'e1', startMin: 0, endMin: 1200 },
      { id: 's2', employeeId: 'e1', startMin: WEEK + 1200, endMin: WEEK + 2401 },
    ],
    [{ id: 'g1', ...CROSS_GAP, requiredQualifications: ['a'] }],
  );
  const { service, dir } = makeService(data);
  try {
    assert.deepEqual(service.getCandidates('g1', 0), []);
    const r = service.invite({ key: 'k1', gapId: 'g1', employeeId: 'e1', nowMin: 0 });
    assert.deepEqual(r, { ok: false, reason: 'weekly_cap_exceeded' });
    // 失败不产生任何占用
    assert.deepEqual(service.getCandidates('g1', 0), []);
  } finally {
    service.close();
    cleanup(dir);
  }
});

test('有效邀约计入周额度，过期后释放', () => {
  // 员工第 0 周已有 2350 分钟固定排班；g1 60 分钟会超额，g2 50 分钟恰好顶满
  const data = dataWith(
    [{ id: 's1', employeeId: 'e1', startMin: 0, endMin: 2350 }],
    [
      { id: 'g1', startMin: 2400, endMin: 2460, requiredQualifications: ['a'] },
      { id: 'g2', startMin: 2400, endMin: 2450, requiredQualifications: ['a'] },
    ],
  );
  const { service, dir } = makeService(data);
  try {
    assert.deepEqual(service.getCandidates('g1', 0), []);
    assert.deepEqual(service.getCandidates('g2', 0), ['e1']);
    const r = service.invite({ key: 'k1', gapId: 'g2', employeeId: 'e1', nowMin: 0 });
    assert.equal(r.ok, true);
    // 待答复期间占用额度：另一个 10 分钟空缺也放不下（2400 已满）
    const data2 = service.getCandidates('g1', 0);
    assert.deepEqual(data2, []);
    // 过期后额度释放
    assert.deepEqual(service.getCandidates('g1', 120), []);
    assert.deepEqual(service.getCandidates('g2', 120), ['e1']);
  } finally {
    service.close();
    cleanup(dir);
  }
});
