import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { InviteService } from '../src/index.ts';
import type { StaticData } from '../src/index.ts';
import { cleanup, tempDbPath } from './helpers.ts';
import { verifyConsistent } from './verify.ts';

// 确定性伪随机，保证测试可复现
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('规模性能：200 员工 / 2000 排班 / 2000 空缺 / 10 万历史邀约，候选查询 < 200ms', () => {
  const rand = mulberry32(42);
  const qualPool = ['a', 'b', 'c', 'd', 'e'];
  const employees = Array.from({ length: 200 }, (_, i) => ({
    id: `e${i}`,
    qualifications: qualPool.filter(() => rand() < 0.5),
  }));
  // 每名员工 10 条互不重叠的固定排班（静态数据由上层保证合法）
  const shifts = Array.from({ length: 2000 }, (_, i) => {
    const employeeIndex = i % 200;
    const slot = Math.floor(i / 200);
    const startMin = slot * 1800 + Math.floor(rand() * 600);
    return {
      id: `s${i}`,
      employeeId: `e${employeeIndex}`,
      startMin,
      endMin: startMin + 30 + Math.floor(rand() * 300),
    };
  });
  const gaps = Array.from({ length: 2000 }, (_, i) => {
    const startMin = Math.floor(rand() * 20000);
    return {
      id: `g${i}`,
      startMin,
      endMin: startMin + 30 + Math.floor(rand() * 300),
      requiredQualifications: rand() < 0.5 ? ['a'] : ['a', 'b'],
    };
  });
  const data: StaticData = { employees, shifts, gaps };

  const { dir, dbPath } = tempDbPath();
  const service = new InviteService(dbPath);
  try {
    service.configure(data);
    // 直接写入 10 万条终态历史邀约（测试数据准备，不经过业务接口）
    const db = new DatabaseSync(dbPath);
    db.exec('BEGIN');
    const insert = db.prepare(
      `INSERT INTO invitations (id, gap_id, employee_id, status, created_min, deadline_min)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (let i = 0; i < 100_000; i++) {
      const status = i % 2 === 0 ? 'rejected' : 'cancelled';
      insert.run(
        `hist-${i}`,
        `g${Math.floor(rand() * 2000)}`,
        `e${Math.floor(rand() * 200)}`,
        status,
        0,
        120,
      );
    }
    db.exec('COMMIT');
    db.close();

    const started = performance.now();
    const candidates = service.getCandidates('g0', 5000);
    const elapsed = performance.now() - started;
    assert.ok(Array.isArray(candidates));
    assert.ok(elapsed < 200, `candidate query took ${elapsed.toFixed(1)}ms >= 200ms`);
    console.log(`    candidate query: ${elapsed.toFixed(1)}ms, ${candidates.length} candidates`);

    verifyConsistent(dbPath, 5000);
  } finally {
    service.close();
    cleanup(dir);
  }
});
