import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RedemptionService } from '../src/index.ts';
import { FakeHr, assertSnapshotConsistent, flush } from './helpers.ts';

const EMPLOYEES = [
  { id: 'emp-1', points: 100 },
  { id: 'emp-2', points: 10 },
];
const REWARDS = [
  { id: 'rw-1', price: 30, stock: 3 },
  { id: 'rw-2', price: 50, stock: 0 },
];

function makeService(hr: FakeHr): RedemptionService {
  return new RedemptionService({
    employees: EMPLOYEES,
    rewards: REWARDS,
    hrHandler: hr.handler,
    retryDelaysMs: [600_000, 1_200_000],
  });
}

test('accept deducts points, stock and quota atomically and starts first attempt', async () => {
  const hr = new FakeHr();
  const service = makeService(hr);
  const result = service.submit({ redemptionId: 'r-1', employeeId: 'emp-1', rewardId: 'rw-1' });
  assert.equal(result.accepted, true);
  assert.equal(result.redemption?.status, 'pending');
  assert.equal(hr.attemptCount('r-1'), 1);

  const snapshot = service.snapshot();
  assert.equal(snapshot.employees.find((e) => e.employeeId === 'emp-1')?.availablePoints, 70);
  assert.equal(snapshot.rewards.find((r) => r.rewardId === 'rw-1')?.availableStock, 2);
  assert.deepEqual(
    snapshot.quotaUsage.filter((q) => q.employeeId === 'emp-1'),
    [{ employeeId: 'emp-1', rewardId: 'rw-1', quarter: result.redemption!.quarter, used: 1 }],
  );
  assertSnapshotConsistent(snapshot, EMPLOYEES, REWARDS);
  service.close();
});

test('insufficient points rejects without any deduction', () => {
  const hr = new FakeHr();
  const service = makeService(hr);
  const result = service.submit({ redemptionId: 'r-2', employeeId: 'emp-2', rewardId: 'rw-1' });
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'INSUFFICIENT_POINTS');
  assert.equal(result.redemption, null);
  assert.equal(hr.calls.length, 0);
  const snapshot = service.snapshot();
  assert.equal(snapshot.employees.find((e) => e.employeeId === 'emp-2')?.availablePoints, 10);
  assert.equal(snapshot.rewards.find((r) => r.rewardId === 'rw-1')?.availableStock, 3);
  assert.equal(snapshot.quotaUsage.length, 0);
  assertSnapshotConsistent(snapshot, EMPLOYEES, REWARDS);
  service.close();
});

test('out of stock rejects without any deduction', () => {
  const hr = new FakeHr();
  const service = makeService(hr);
  const result = service.submit({ redemptionId: 'r-3', employeeId: 'emp-1', rewardId: 'rw-2' });
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'OUT_OF_STOCK');
  const snapshot = service.snapshot();
  assert.equal(snapshot.employees.find((e) => e.employeeId === 'emp-1')?.availablePoints, 100);
  assertSnapshotConsistent(snapshot, EMPLOYEES, REWARDS);
  service.close();
});

test('unknown employee and reward are rejected', () => {
  const hr = new FakeHr();
  const service = makeService(hr);
  assert.equal(
    service.submit({ redemptionId: 'r-4', employeeId: 'ghost', rewardId: 'rw-1' }).reason,
    'UNKNOWN_EMPLOYEE',
  );
  assert.equal(
    service.submit({ redemptionId: 'r-5', employeeId: 'emp-1', rewardId: 'ghost' }).reason,
    'UNKNOWN_REWARD',
  );
  assertSnapshotConsistent(service.snapshot(), EMPLOYEES, REWARDS);
  service.close();
});

test('quota allows two per employee/reward/quarter, third is rejected', () => {
  const hr = new FakeHr();
  const service = makeService(hr);
  assert.equal(service.submit({ redemptionId: 'q-1', employeeId: 'emp-1', rewardId: 'rw-1' }).accepted, true);
  assert.equal(service.submit({ redemptionId: 'q-2', employeeId: 'emp-1', rewardId: 'rw-1' }).accepted, true);
  const third = service.submit({ redemptionId: 'q-3', employeeId: 'emp-1', rewardId: 'rw-1' });
  assert.equal(third.accepted, false);
  assert.equal(third.reason, 'QUOTA_EXCEEDED');
  const snapshot = service.snapshot();
  assert.equal(snapshot.quotaUsage[0]?.used, 2);
  assert.equal(snapshot.rewards.find((r) => r.rewardId === 'rw-1')?.availableStock, 1);
  assertSnapshotConsistent(snapshot, EMPLOYEES, REWARDS);
  service.close();
});

test('duplicate submit returns same redemption without double deduction or new attempts', async () => {
  const hr = new FakeHr();
  const service = makeService(hr);
  const first = service.submit({ redemptionId: 'dup-1', employeeId: 'emp-1', rewardId: 'rw-1' });
  const second = service.submit({ redemptionId: 'dup-1', employeeId: 'emp-1', rewardId: 'rw-1' });
  assert.equal(second.accepted, true);
  assert.equal(second.redemption?.id, 'dup-1');
  assert.equal(hr.attemptCount('dup-1'), 1);
  const snapshot = service.snapshot();
  assert.equal(snapshot.employees.find((e) => e.employeeId === 'emp-1')?.availablePoints, 70);
  assert.equal(snapshot.redemptions.length, 1);
  assertSnapshotConsistent(snapshot, EMPLOYEES, REWARDS);
  await flush();
  service.close();
});

test('duplicate cancel releases resources only once', async () => {
  const hr = new FakeHr();
  const service = makeService(hr);
  service.submit({ redemptionId: 'c-1', employeeId: 'emp-1', rewardId: 'rw-1' });
  hr.attemptsOf('c-1')[0].reject();
  await flush();
  const first = service.cancel('c-1');
  assert.equal(first.status, 'cancelled');
  const second = service.cancel('c-1');
  assert.equal(second.status, 'cancelled');
  const snapshot = service.snapshot();
  assert.equal(snapshot.employees.find((e) => e.employeeId === 'emp-1')?.availablePoints, 100);
  assert.equal(snapshot.rewards.find((r) => r.rewardId === 'rw-1')?.availableStock, 3);
  assert.equal(snapshot.quotaUsage[0]?.used, 0);
  assertSnapshotConsistent(snapshot, EMPLOYEES, REWARDS);
  service.close();
});
