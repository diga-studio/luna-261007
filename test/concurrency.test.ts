import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { InviteService } from '../src/index.ts';
import type { InviteResult } from '../src/index.ts';
import type { StaticData } from '../src/index.ts';
import { cleanup, tempDbPath } from './helpers.ts';
import { verifyConsistent } from './verify.ts';

const runFile = promisify(execFile);
const workerPath = join(dirname(fileURLToPath(import.meta.url)), 'worker.ts');

const data: StaticData = {
  employees: [
    { id: 'e1', qualifications: ['a'] },
    { id: 'e2', qualifications: ['a'] },
  ],
  shifts: [],
  gaps: [
    { id: 'g1', startMin: 1000, endMin: 1100, requiredQualifications: ['a'] },
    { id: 'g2', startMin: 1050, endMin: 1150, requiredQualifications: ['a'] },
  ],
};

async function runWorker(
  dbPath: string,
  key: string,
  gapId: string,
  employeeId: string,
  nowMin: number,
): Promise<InviteResult> {
  const { stdout } = await runFile(
    process.execPath,
    [workerPath, dbPath, key, gapId, employeeId, String(nowMin)],
  );
  return JSON.parse(stdout) as InviteResult;
}

test('多进程并发争抢同一空缺：恰好一个成功，同键并发只执行一次', async () => {
  const { dir, dbPath } = tempDbPath();
  const setup = new InviteService(dbPath);
  setup.configure(data);
  setup.close();
  try {
    // 8 个进程用不同键同时抢同一空缺
    const racing = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        runWorker(dbPath, `race-${i}`, 'g1', i % 2 === 0 ? 'e1' : 'e2', 0),
      ),
    );
    const winners = racing.filter((r) => r.ok);
    assert.equal(winners.length, 1, `expected 1 winner, got ${winners.length}`);
    const losers = racing.filter((r) => !r.ok);
    assert.equal(losers.length, 7);
    for (const loser of losers) {
      assert.equal(loser.ok && false, false);
      assert.equal((loser as { reason: string }).reason, 'gap_occupied');
    }

    // 4 个进程用同一键同一参数并发提交：结果一致，只执行一次
    const sameKey = await Promise.all(
      Array.from({ length: 4 }, () =>
        runWorker(dbPath, 'shared-key', 'g1', 'e1', 0),
      ),
    );
    for (const r of sameKey) assert.deepEqual(r, sameKey[0]);

    verifyConsistent(dbPath, 0);

    // 关闭重开后用相同键重试：返回首次结果，不产生新邀约
    const reopened = new InviteService(dbPath);
    try {
      const winnerKey = 'race-0';
      const first = racing[0]!;
      const retry = reopened.invite({
        key: winnerKey,
        gapId: 'g1',
        employeeId: 'e1',
        nowMin: 30,
      });
      if (first.ok) {
        assert.deepEqual(retry, first);
      } else {
        // race-0 若未获胜，重试同样返回首次失败结果
        assert.deepEqual(retry, first);
      }
      const retryShared = reopened.invite({
        key: 'shared-key', gapId: 'g1', employeeId: 'e1', nowMin: 40,
      });
      assert.deepEqual(retryShared, sameKey[0]);
    } finally {
      reopened.close();
    }
    verifyConsistent(dbPath, 60);

    // 8 个进程同时抢同一员工在两个重叠空缺上的邀约：恰好一个成功
    const overlapRace = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        runWorker(dbPath, `overlap-${i}`, i % 2 === 0 ? 'g1' : 'g2', 'e2', 130),
      ),
    );
    const overlapWinners = overlapRace.filter((r) => r.ok);
    assert.equal(overlapWinners.length, 1, `expected 1 winner, got ${overlapWinners.length}`);
    verifyConsistent(dbPath, 130);
  } finally {
    cleanup(dir);
  }
});
