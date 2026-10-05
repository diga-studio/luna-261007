import { test } from 'node:test';
import { deepEqual, equal, ok } from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ShiftCoverService, StaticContext } from '../src/index';
import { assertConsistentOccupancy, emp, makeWorld, opening, WEEK0 } from './helpers';

interface OpPayload {
  op: 'create' | 'accept' | 'decline' | 'cancel';
  key: string;
  openingId?: string;
  employeeId?: string;
  invitationId?: string;
  now: number;
}

interface WorkerOutcome {
  code: number | null;
  result: { ok: boolean; value?: { invitationId?: string }; reason?: string };
}

function runWorker(contextFile: string, dbPath: string, op: OpPayload): Promise<WorkerOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.argv[0] as string, [
      join(__dirname, 'worker.js'),
      contextFile,
      dbPath,
      JSON.stringify(op),
    ]);
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`worker exited ${code}: ${stderr}`));
        return;
      }
      resolve({ code, result: JSON.parse(stdout) });
    });
  });
}

function countRows(dbPath: string, where: string): number {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare(`SELECT COUNT(*) AS c FROM invitations ${where}`).get() as {
      c: number;
    };
    return Number(row.c);
  } finally {
    db.close();
  }
}

const DAY = 24 * 60;

test('并发：8 个进程争抢同一空缺，恰好一个成功', async () => {
  const employees = Array.from({ length: 8 }, (_, i) => emp(`E${i}`));
  const context: StaticContext = {
    employees,
    fixedShifts: [],
    openings: [opening('O1', WEEK0, WEEK0 + 8 * 60)],
  };
  const world = makeWorld(context, 'conc-opening');
  try {
    const contextFile = join(world.dir, 'context.json');
    writeFileSync(contextFile, JSON.stringify(context));
    const now = WEEK0 - DAY;
    const outcomes = await Promise.all(
      employees.map((e, i) =>
        runWorker(contextFile, world.dbPath, {
          op: 'create',
          key: `k${i}`,
          openingId: 'O1',
          employeeId: e.id,
          now,
        }),
      ),
    );
    const succeeded = outcomes.filter((o) => o.result.ok);
    const occupied = outcomes.filter((o) => !o.result.ok && o.result.reason === 'opening_occupied');
    equal(succeeded.length, 1, `expect exactly 1 success, got ${JSON.stringify(outcomes)}`);
    equal(occupied.length, 7);
    equal(countRows(world.dbPath, ''), 1);

    const check = new ShiftCoverService({ dbPath: world.dbPath, context });
    try {
      assertConsistentOccupancy(context, check.listActiveInvitations(now + 1));
    } finally {
      check.close();
    }
  } finally {
    world.cleanup();
  }
});

test('并发：2 个进程争抢同一员工的重叠空缺，恰好一个成功', async () => {
  const context: StaticContext = {
    employees: [emp('E1')],
    fixedShifts: [],
    openings: [
      opening('O1', WEEK0, WEEK0 + 10 * 60),
      opening('O2', WEEK0 + 5 * 60, WEEK0 + 15 * 60),
    ],
  };
  const world = makeWorld(context, 'conc-employee');
  try {
    const contextFile = join(world.dir, 'context.json');
    writeFileSync(contextFile, JSON.stringify(context));
    const now = WEEK0 - DAY;
    const outcomes = await Promise.all([
      runWorker(contextFile, world.dbPath, {
        op: 'create',
        key: 'a',
        openingId: 'O1',
        employeeId: 'E1',
        now,
      }),
      runWorker(contextFile, world.dbPath, {
        op: 'create',
        key: 'b',
        openingId: 'O2',
        employeeId: 'E1',
        now,
      }),
    ]);
    const succeeded = outcomes.filter((o) => o.result.ok);
    const conflicted = outcomes.filter((o) => !o.result.ok && o.result.reason === 'time_conflict');
    equal(succeeded.length, 1, `expect exactly 1 success, got ${JSON.stringify(outcomes)}`);
    equal(conflicted.length, 1);

    const check = new ShiftCoverService({ dbPath: world.dbPath, context });
    try {
      assertConsistentOccupancy(context, check.listActiveInvitations(now + 1));
    } finally {
      check.close();
    }
  } finally {
    world.cleanup();
  }
});

test('并发：同幂等键同参数并发提交只执行一次', async () => {
  const context: StaticContext = {
    employees: [emp('E1')],
    fixedShifts: [],
    openings: [opening('O1', WEEK0, WEEK0 + 8 * 60)],
  };
  const world = makeWorld(context, 'conc-idem');
  try {
    const contextFile = join(world.dir, 'context.json');
    writeFileSync(contextFile, JSON.stringify(context));
    const now = WEEK0 - DAY;
    const outcomes = await Promise.all(
      [0, 1, 2, 3].map(() =>
        runWorker(contextFile, world.dbPath, {
          op: 'create',
          key: 'same-key',
          openingId: 'O1',
          employeeId: 'E1',
          now,
        }),
      ),
    );
    // 全部返回首次成功结果，且 invitationId 相同，库里只有一条邀约。
    for (const outcome of outcomes) {
      ok(outcome.result.ok, `expect ok, got ${JSON.stringify(outcome)}`);
    }
    const ids = new Set(outcomes.map((o) => o.result.value?.invitationId));
    equal(ids.size, 1);
    equal(countRows(world.dbPath, ''), 1);

    // 关闭重开后同键重试仍返回首次结果，不产生新邀约。
    const check = new ShiftCoverService({ dbPath: world.dbPath, context });
    try {
      const retry = check.createInvitation({
        idempotencyKey: 'same-key',
        openingId: 'O1',
        employeeId: 'E1',
        now: now + 10,
      });
      deepEqual(retry, outcomes[0]!.result);
      equal(countRows(world.dbPath, ''), 1);
      assertConsistentOccupancy(context, check.listActiveInvitations(now + 11));
    } finally {
      check.close();
    }
  } finally {
    world.cleanup();
  }
});

test('并发：接受与拒绝竞争同一邀约，恰好一个生效', async () => {
  const context: StaticContext = {
    employees: [emp('E1')],
    fixedShifts: [],
    openings: [opening('O1', WEEK0, WEEK0 + 8 * 60)],
  };
  const world = makeWorld(context, 'conc-accept-decline');
  try {
    const now = WEEK0 - DAY;
    const created = world.service.createInvitation({
      idempotencyKey: 'seed',
      openingId: 'O1',
      employeeId: 'E1',
      now,
    });
    ok(created.ok);
    const invitationId = created.ok ? created.value.invitationId : '';

    const contextFile = join(world.dir, 'context.json');
    writeFileSync(contextFile, JSON.stringify(context));
    const outcomes = await Promise.all([
      runWorker(contextFile, world.dbPath, {
        op: 'accept',
        key: 'op-accept',
        invitationId,
        now: now + 1,
      }),
      runWorker(contextFile, world.dbPath, {
        op: 'decline',
        key: 'op-decline',
        invitationId,
        now: now + 1,
      }),
    ]);
    // 串行化后恰好一个成功、一个因邀约已进入终态而失败。
    const succeeded = outcomes.filter((o) => o.result.ok);
    equal(succeeded.length, 1, `expect exactly 1 success, got ${JSON.stringify(outcomes)}`);
    const failed = outcomes.filter((o) => !o.result.ok);
    equal(failed.length, 1);
    equal(failed[0]!.result.reason, 'not_pending');

    const check = new ShiftCoverService({ dbPath: world.dbPath, context });
    try {
      const active = check.listActiveInvitations(now + 2);
      // 赢家为 accept 则占用有效，赢家为 decline 则占用已释放。
      const acceptWon = outcomes[0]!.result.ok;
      equal(active.length, acceptWon ? 1 : 0);
      assertConsistentOccupancy(context, active);
    } finally {
      check.close();
    }
  } finally {
    world.cleanup();
  }
});
