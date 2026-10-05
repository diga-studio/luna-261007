import { test } from 'node:test';
import { deepEqual, equal, ok } from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ShiftCoverService } from '../src/index';
import {
  assertConsistentOccupancy,
  emp,
  makeWorld,
  opening,
  shift,
  WEEK0,
} from './helpers';

const H = 60;
const DAY = 24 * H;

function countInvitations(dbPath: string): number {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare('SELECT COUNT(*) AS c FROM invitations').get() as { c: number };
    return Number(row.c);
  } finally {
    db.close();
  }
}

test('跨周邀约分别顶满两周额度（恰好等于允许）', () => {
  // 空缺：week0 周六 12:00 -> week1 周一 12:00，跨两周，week0 占 2160 分钟，week1 占 720 分钟。
  const start = WEEK0 + 5 * DAY + 12 * H;
  const end = WEEK0 + 7 * DAY + 12 * H;
  const world = makeWorld(
    {
      employees: [emp('E1'), emp('E2')],
      fixedShifts: [
        // E1：week0 已有 240 分钟，week1 已有 1680 分钟 -> 加上空缺后两周都恰好 2400。
        shift('E1', WEEK0, WEEK0 + 4 * H),
        shift('E1', WEEK0 + 8 * DAY, WEEK0 + 8 * DAY + 28 * H),
        // E2：week1 已有 1681 分钟 -> 加上空缺后 week1 超额。
        shift('E2', WEEK0 + 8 * DAY, WEEK0 + 8 * DAY + 28 * H + 1),
      ],
      openings: [opening('O1', start, end)],
    },
    'crossweek',
  );
  try {
    const now = WEEK0 - 10 * DAY;
    deepEqual(world.service.getCandidates('O1', now), ['E1']);

    const created = world.service.createInvitation({
      idempotencyKey: 'k-cross',
      openingId: 'O1',
      employeeId: 'E1',
      now,
    });
    ok(created.ok);
    const accepted = world.service.acceptInvitation({
      idempotencyKey: 'k-cross-accept',
      invitationId: created.ok ? created.value.invitationId : '',
      now: now + 1,
    });
    ok(accepted.ok);

    // E2 仅 week1 超额：不在候选中，直接发起也失败。
    const denied = world.service.createInvitation({
      idempotencyKey: 'k-over',
      openingId: 'O1',
      employeeId: 'E2',
      now: now + 2,
    });
    deepEqual(denied, { ok: false, reason: 'opening_occupied' });

    assertConsistentOccupancy(world.context, world.service.listActiveInvitations(now + 3));
  } finally {
    world.cleanup();
  }
});

test('仅一周超额时发起邀约失败且不产生占用', () => {
  const start = WEEK0 + 5 * DAY + 12 * H;
  const end = WEEK0 + 7 * DAY + 12 * H;
  const world = makeWorld(
    {
      employees: [emp('E2')],
      fixedShifts: [shift('E2', WEEK0 + 8 * DAY, WEEK0 + 8 * DAY + 28 * H + 1)],
      openings: [opening('O1', start, end)],
    },
    'weekoverflow',
  );
  try {
    const now = WEEK0 - 10 * DAY;
    deepEqual(world.service.getCandidates('O1', now), []);
    const created = world.service.createInvitation({
      idempotencyKey: 'k1',
      openingId: 'O1',
      employeeId: 'E2',
      now,
    });
    deepEqual(created, { ok: false, reason: 'weekly_cap_exceeded' });
    equal(countInvitations(world.dbPath), 0);
    // 失败不改变占用：空缺仍然可邀（虽然没有合格员工）。
    assertConsistentOccupancy(world.context, world.service.listActiveInvitations(now));
  } finally {
    world.cleanup();
  }
});

test('多个主管争抢同一员工：后到邀约因时间冲突失败', () => {
  const world = makeWorld(
    {
      employees: [emp('E1'), emp('E2')],
      fixedShifts: [],
      openings: [
        opening('O1', WEEK0, WEEK0 + 10 * H),
        opening('O2', WEEK0 + 5 * H, WEEK0 + 15 * H),
      ],
    },
    'race-employee',
  );
  try {
    const now = WEEK0 - DAY;
    const first = world.service.createInvitation({
      idempotencyKey: 's1',
      openingId: 'O1',
      employeeId: 'E1',
      now,
    });
    ok(first.ok);
    // 同一员工被另一个主管争抢重叠空缺 -> 时间冲突。
    const second = world.service.createInvitation({
      idempotencyKey: 's2',
      openingId: 'O2',
      employeeId: 'E1',
      now: now + 1,
    });
    deepEqual(second, { ok: false, reason: 'time_conflict' });
    // 另一员工仍可受邀 O2。
    const third = world.service.createInvitation({
      idempotencyKey: 's3',
      openingId: 'O2',
      employeeId: 'E2',
      now: now + 2,
    });
    ok(third.ok);
    assertConsistentOccupancy(world.context, world.service.listActiveInvitations(now + 3));
  } finally {
    world.cleanup();
  }
});

test('多个主管争抢同一空缺：后到邀约因空缺占用失败', () => {
  const world = makeWorld(
    {
      employees: [emp('E1'), emp('E2')],
      fixedShifts: [],
      openings: [opening('O1', WEEK0, WEEK0 + 8 * H)],
    },
    'race-opening',
  );
  try {
    const now = WEEK0 - DAY;
    ok(
      world.service.createInvitation({
        idempotencyKey: 's1',
        openingId: 'O1',
        employeeId: 'E1',
        now,
      }).ok,
    );
    // 待答复邀约也占用空缺。
    deepEqual(world.service.getCandidates('O1', now + 1), []);
    const second = world.service.createInvitation({
      idempotencyKey: 's2',
      openingId: 'O1',
      employeeId: 'E2',
      now: now + 1,
    });
    deepEqual(second, { ok: false, reason: 'opening_occupied' });
    assertConsistentOccupancy(world.context, world.service.listActiveInvitations(now + 2));
  } finally {
    world.cleanup();
  }
});

test('截止时刻过期：重新指派后旧接受与旧取消到达不影响新邀约', () => {
  const world = makeWorld(
    {
      employees: [emp('E1'), emp('E2')],
      fixedShifts: [],
      openings: [opening('O1', WEEK0, WEEK0 + 8 * H)],
    },
    'deadline',
  );
  try {
    const t0 = WEEK0 - DAY;
    const first = world.service.createInvitation({
      idempotencyKey: 'old',
      openingId: 'O1',
      employeeId: 'E1',
      now: t0,
    });
    ok(first.ok);
    const oldId = first.ok ? first.value.invitationId : '';
    const deadline = t0 + 120;

    // 截止前 1 分钟仍占用；截止时刻即过期，可重新指派。
    deepEqual(world.service.getCandidates('O1', deadline - 1), []);
    deepEqual(world.service.getCandidates('O1', deadline), ['E1', 'E2']);

    const second = world.service.createInvitation({
      idempotencyKey: 'new',
      openingId: 'O1',
      employeeId: 'E2',
      now: deadline,
    });
    ok(second.ok);
    const newId = second.ok ? second.value.invitationId : '';

    // 旧接受迟到：已过期，不能生效。
    const lateAccept = world.service.acceptInvitation({
      idempotencyKey: 'old-accept',
      invitationId: oldId,
      now: deadline + 1,
    });
    deepEqual(lateAccept, { ok: false, reason: 'not_pending' });
    // 旧取消迟到：同样无效。
    const lateCancel = world.service.cancelInvitation({
      idempotencyKey: 'old-cancel',
      invitationId: oldId,
      now: deadline + 2,
    });
    deepEqual(lateCancel, { ok: false, reason: 'not_cancellable' });

    // 新邀约不受影响：仍有效，且可以接受。
    const active = world.service.listActiveInvitations(deadline + 3);
    deepEqual(
      active.map((i) => i.id),
      [newId],
    );
    ok(
      world.service.acceptInvitation({
        idempotencyKey: 'new-accept',
        invitationId: newId,
        now: deadline + 10,
      }).ok,
    );
    // 接受后不再受原截止时间限制：远超截止时间仍保持有效占用。
    assertConsistentOccupancy(world.context, world.service.listActiveInvitations(deadline + 400));
    deepEqual(
      world.service.listActiveInvitations(deadline + 400).map((i) => i.id),
      [newId],
    );
    assertConsistentOccupancy(world.context, world.service.listActiveInvitations(deadline + 401));
  } finally {
    world.cleanup();
  }
});

test('接受/拒绝只能作用于未过期待答复邀约；取消释放占用', () => {
  const world = makeWorld(
    {
      employees: [emp('E1'), emp('E2')],
      fixedShifts: [],
      openings: [opening('O1', WEEK0, WEEK0 + 8 * H), opening('O2', WEEK0 + DAY, WEEK0 + DAY + 8 * H)],
    },
    'respond',
  );
  try {
    const t0 = WEEK0 - DAY;
    const inv1 = world.service.createInvitation({
      idempotencyKey: 'i1',
      openingId: 'O1',
      employeeId: 'E1',
      now: t0,
    });
    ok(inv1.ok);
    const id1 = inv1.ok ? inv1.value.invitationId : '';

    // 重复接受：第一次成功，第二次（不同幂等键）已是终态 -> not_pending。
    ok(
      world.service.acceptInvitation({ idempotencyKey: 'a1', invitationId: id1, now: t0 + 1 }).ok,
    );
    deepEqual(
      world.service.acceptInvitation({ idempotencyKey: 'a2', invitationId: id1, now: t0 + 2 }),
      { ok: false, reason: 'not_pending' },
    );
    // 已接受邀约可取消，取消后立即释放。
    ok(
      world.service.cancelInvitation({ idempotencyKey: 'c1', invitationId: id1, now: t0 + 3 }).ok,
    );
    deepEqual(world.service.getCandidates('O1', t0 + 4), ['E1', 'E2']);
    // 已取消邀约不能重新生效。
    deepEqual(
      world.service.acceptInvitation({ idempotencyKey: 'a3', invitationId: id1, now: t0 + 5 }),
      { ok: false, reason: 'not_pending' },
    );

    // 拒绝立即释放。
    const inv2 = world.service.createInvitation({
      idempotencyKey: 'i2',
      openingId: 'O2',
      employeeId: 'E1',
      now: t0,
    });
    ok(inv2.ok);
    const id2 = inv2.ok ? inv2.value.invitationId : '';
    ok(
      world.service.declineInvitation({ idempotencyKey: 'd2', invitationId: id2, now: t0 + 1 }).ok,
    );
    deepEqual(world.service.getCandidates('O2', t0 + 2), ['E1', 'E2']);
    assertConsistentOccupancy(world.context, world.service.listActiveInvitations(t0 + 6));
  } finally {
    world.cleanup();
  }
});

test('幂等：同键同参返回首次结果；同键不同参拒绝；取消后重试不复活', () => {
  const world = makeWorld(
    {
      employees: [emp('E1'), emp('E2')],
      fixedShifts: [],
      openings: [opening('O1', WEEK0, WEEK0 + 8 * H)],
    },
    'idem',
  );
  try {
    const t0 = WEEK0 - DAY;
    const first = world.service.createInvitation({
      idempotencyKey: 'K',
      openingId: 'O1',
      employeeId: 'E1',
      now: t0,
    });
    ok(first.ok);
    const id1 = first.ok ? first.value.invitationId : '';

    // 同键同参（调用时间不同也视为同参）：返回首次结果，不产生新邀约。
    const retry = world.service.createInvitation({
      idempotencyKey: 'K',
      openingId: 'O1',
      employeeId: 'E1',
      now: t0 + 50,
    });
    deepEqual(retry, first);
    equal(countInvitations(world.dbPath), 1);

    // 同键不同业务参数：拒绝。
    deepEqual(
      world.service.createInvitation({
        idempotencyKey: 'K',
        openingId: 'O1',
        employeeId: 'E2',
        now: t0 + 51,
      }),
      { ok: false, reason: 'idempotency_conflict' },
    );

    // 取消后重试同键创建：返回首次成功结果，但不产生新邀约、不复活。
    ok(
      world.service.cancelInvitation({ idempotencyKey: 'KC', invitationId: id1, now: t0 + 60 }).ok,
    );
    const retryAfterCancel = world.service.createInvitation({
      idempotencyKey: 'K',
      openingId: 'O1',
      employeeId: 'E1',
      now: t0 + 61,
    });
    deepEqual(retryAfterCancel, first);
    equal(countInvitations(world.dbPath), 1);
    deepEqual(world.service.listActiveInvitations(t0 + 62), []);

    // 关闭重开后重试：幂等语义保留。
    world.service.close();
    const reopened = new ShiftCoverService({ dbPath: world.dbPath, context: world.context });
    try {
      const retryAfterReopen = reopened.createInvitation({
        idempotencyKey: 'K',
        openingId: 'O1',
        employeeId: 'E1',
        now: t0 + 70,
      });
      deepEqual(retryAfterReopen, first);
      equal(countInvitations(world.dbPath), 1);
      // 已取消的邀约不会复活，空缺可以重新邀约他人。
      deepEqual(reopened.listActiveInvitations(t0 + 71), []);
      const again = reopened.createInvitation({
        idempotencyKey: 'K2',
        openingId: 'O1',
        employeeId: 'E2',
        now: t0 + 72,
      });
      ok(again.ok);
      assertConsistentOccupancy(world.context, reopened.listActiveInvitations(t0 + 73));
    } finally {
      reopened.close();
    }
  } finally {
    world.cleanup();
  }
});

test('过期后重试创建不延长截止', () => {
  const world = makeWorld(
    {
      employees: [emp('E1')],
      fixedShifts: [],
      openings: [opening('O1', WEEK0, WEEK0 + 8 * H)],
    },
    'idem-expire',
  );
  try {
    const t0 = WEEK0 - DAY;
    const first = world.service.createInvitation({
      idempotencyKey: 'K',
      openingId: 'O1',
      employeeId: 'E1',
      now: t0,
    });
    ok(first.ok);
    const id1 = first.ok ? first.value.invitationId : '';
    // 过期后同键重试：返回首次结果，但邀约保持过期，不接受。
    const retry = world.service.createInvitation({
      idempotencyKey: 'K',
      openingId: 'O1',
      employeeId: 'E1',
      now: t0 + 500,
    });
    deepEqual(retry, first);
    deepEqual(
      world.service.acceptInvitation({ idempotencyKey: 'A', invitationId: id1, now: t0 + 501 }),
      { ok: false, reason: 'not_pending' },
    );
    deepEqual(world.service.listActiveInvitations(t0 + 502), []);
  } finally {
    world.cleanup();
  }
});
