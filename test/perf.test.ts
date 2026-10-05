import { test } from 'node:test';
import { equal, ok } from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ShiftCoverService, StaticContext } from '../src/index';
import { emp, makeWorld, opening, shift, WEEK0 } from './helpers';

const DAY = 24 * 60;
const WEEK = 7 * DAY;

test('规模：200 员工 / 2000 排班 / 2000 空缺 / 10 万历史邀约下候选查询 < 200ms', () => {
  const employees = Array.from({ length: 200 }, (_, i) => emp(`E${i}`, [`Q${i % 5}`]));
  const fixedShifts = [];
  for (let i = 0; i < 200; i++) {
    for (let k = 0; k < 10; k++) {
      fixedShifts.push(shift(`E${i}`, WEEK0 + k * 150, WEEK0 + k * 150 + 60));
    }
  }
  const openings = [];
  for (let j = 0; j < 2000; j++) {
    openings.push(opening(`O${j}`, WEEK0 + 2 * WEEK + j * 500, WEEK0 + 2 * WEEK + j * 500 + 480, [`Q${j % 5}`]));
  }
  const context: StaticContext = { employees, fixedShifts, openings };
  const world = makeWorld(context, 'perf');
  try {
    // 直接写入 10 万条终态邀约 + 少量有效邀约。
    const db = new DatabaseSync(world.dbPath);
    try {
      db.exec('BEGIN');
      const stmt = db.prepare(
        `INSERT INTO invitations
         (id, idempotency_key, opening_id, employee_id, start_minute, end_minute,
          status, created_minute, deadline_minute, updated_minute)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const statuses = ['declined', 'cancelled', 'expired'];
      for (let n = 0; n < 100000; n++) {
        const created = WEEK0 - 3 * WEEK + (n % 1000);
        stmt.run(
          `hist-${n}`,
          `hist-key-${n}`,
          `O${n % 2000}`,
          `E${n % 200}`,
          created,
          created + 480,
          statuses[n % 3],
          created - 120,
          created,
          created,
        );
      }
      // 50 条有效邀约（已接受），落在另一周。
      for (let n = 0; n < 50; n++) {
        const start = WEEK0 + 5 * WEEK + n * 600;
        stmt.run(
          `active-${n}`,
          `active-key-${n}`,
          `O${n}`,
          `E${n}`,
          start,
          start + 480,
          'accepted',
          start - 200,
          start - 80,
          start - 80,
        );
      }
      db.exec('COMMIT');
    } finally {
      db.close();
    }

    const now = WEEK0 + WEEK;
    // 预热一次（加载 page cache），再正式计时。
    world.service.getCandidates('O1000', now);
    let worst = 0;
    let candidateCount = 0;
    for (let round = 0; round < 5; round++) {
      const t0 = Date.now();
      const candidates = world.service.getCandidates('O1000', now);
      const elapsed = Date.now() - t0;
      worst = Math.max(worst, elapsed);
      candidateCount = candidates.length;
    }
    ok(worst < 200, `candidate query took ${worst}ms, expected < 200ms`);
    // O1000 需要资格 Q0：200 名员工中 40 名具备，其中 E0/E5/.../E45 等已被有效邀约占用者除外。
    // accepted 邀约在 week5，O1000 在 week2，不冲突 -> 40 名全部可邀。
    equal(candidateCount, 40);
  } finally {
    world.cleanup();
  }
});
