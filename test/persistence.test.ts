import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { RedemptionService } from '../src/index.ts';
import { FakeHr } from './helpers.ts';

test('state is persisted in the SQLite database file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'redemption-'));
  const dbPath = join(dir, 'state.db');
  const hr = new FakeHr();
  const service = new RedemptionService({
    dbPath,
    employees: [{ id: 'emp-1', points: 100 }],
    rewards: [{ id: 'rw-1', price: 30, stock: 2 }],
    hrHandler: hr.handler,
    retryDelaysMs: [600_000, 1_200_000],
  });
  service.submit({ redemptionId: 'p-1', employeeId: 'emp-1', rewardId: 'rw-1' });
  service.close();

  const db = new DatabaseSync(dbPath);
  const employee = db.prepare('SELECT points FROM employees WHERE id = ?').get('emp-1') as {
    points: number;
  };
  const redemption = db.prepare('SELECT status FROM redemptions WHERE id = ?').get('p-1') as {
    status: string;
  };
  db.close();
  assert.equal(employee.points, 70);
  assert.equal(redemption.status, 'pending');
  rmSync(dir, { recursive: true, force: true });
});
