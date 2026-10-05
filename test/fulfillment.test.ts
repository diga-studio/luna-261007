import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RedemptionService } from '../src/index.ts';
import { FakeHr, assertSnapshotConsistent, flush, sleep } from './helpers.ts';

const EMPLOYEES = [{ id: 'emp-1', points: 1000 }];
const REWARDS = [{ id: 'rw-1', price: 100, stock: 10 }];

function makeService(hr: FakeHr, options?: {
  retryDelaysMs?: [number, number];
  now?: () => Date;
}): RedemptionService {
  return new RedemptionService({
    employees: EMPLOYEES,
    rewards: REWARDS,
    hrHandler: hr.handler,
    retryDelaysMs: options?.retryDelaysMs ?? [600_000, 1_200_000],
    now: options?.now,
  });
}

test('retries start at configured delays, capped at three attempts', async () => {
  const hr = new FakeHr();
  const service = makeService(hr, { retryDelaysMs: [30, 60] });
  service.submit({ redemptionId: 'rt-1', employeeId: 'emp-1', rewardId: 'rw-1' });
  assert.equal(hr.attemptCount('rt-1'), 1);
  await sleep(50);
  assert.equal(hr.attemptCount('rt-1'), 2);
  await sleep(40);
  assert.equal(hr.attemptCount('rt-1'), 3);
  await sleep(80);
  assert.equal(hr.attemptCount('rt-1'), 3);
  assert.equal(service.getRedemption('rt-1')?.status, 'pending');
  service.close();
});

test('early failure does not move the next attempt earlier', async () => {
  const hr = new FakeHr();
  const service = makeService(hr, { retryDelaysMs: [50, 100] });
  service.submit({ redemptionId: 'rt-2', employeeId: 'emp-1', rewardId: 'rw-1' });
  hr.attemptsOf('rt-2')[0].reject();
  await flush();
  await sleep(20);
  assert.equal(hr.attemptCount('rt-2'), 1);
  await sleep(50);
  assert.equal(hr.attemptCount('rt-2'), 2);
  service.close();
});

test('late success of an old attempt completes after a newer attempt failed', async () => {
  const hr = new FakeHr();
  const service = makeService(hr, { retryDelaysMs: [20, 40] });
  service.submit({ redemptionId: 'rt-3', employeeId: 'emp-1', rewardId: 'rw-1' });
  await sleep(70);
  assert.equal(hr.attemptCount('rt-3'), 3);
  hr.attemptsOf('rt-3')[2].reject();
  await flush();
  assert.equal(service.getRedemption('rt-3')?.status, 'pending');
  hr.attemptsOf('rt-3')[0].resolve();
  await flush();
  assert.equal(service.getRedemption('rt-3')?.status, 'completed');
  hr.attemptsOf('rt-3')[1].reject();
  await flush();
  assert.equal(service.getRedemption('rt-3')?.status, 'completed');
  const snapshot = service.snapshot();
  assert.equal(snapshot.employees[0]?.availablePoints, 900);
  assert.equal(snapshot.rewards[0]?.availableStock, 9);
  assertSnapshotConsistent(snapshot, EMPLOYEES, REWARDS);
  service.close();
});

test('three explicit failures reject and refund everything exactly once', async () => {
  const hr = new FakeHr();
  const service = makeService(hr, { retryDelaysMs: [20, 40] });
  service.submit({ redemptionId: 'rt-4', employeeId: 'emp-1', rewardId: 'rw-1' });
  await sleep(70);
  for (const attempt of hr.attemptsOf('rt-4')) attempt.reject();
  await flush();
  assert.equal(service.getRedemption('rt-4')?.status, 'rejected');
  const snapshot = service.snapshot();
  assert.equal(snapshot.employees[0]?.availablePoints, 1000);
  assert.equal(snapshot.rewards[0]?.availableStock, 10);
  assert.equal(snapshot.quotaUsage[0]?.used, 0);
  assertSnapshotConsistent(snapshot, EMPLOYEES, REWARDS);
  service.close();
});

test('cancel during outstanding attempt stays cancelling, late success completes without refund', async () => {
  const hr = new FakeHr();
  const service = makeService(hr, { retryDelaysMs: [20, 40] });
  service.submit({ redemptionId: 'cx-1', employeeId: 'emp-1', rewardId: 'rw-1' });
  await sleep(30);
  assert.equal(hr.attemptCount('cx-1'), 2);
  const cancelling = service.cancel('cx-1');
  assert.equal(cancelling.status, 'cancelling');
  let snapshot = service.snapshot();
  assert.equal(snapshot.employees[0]?.availablePoints, 900);
  assert.equal(snapshot.rewards[0]?.availableStock, 9);
  hr.attemptsOf('cx-1')[1].reject();
  await flush();
  assert.equal(service.getRedemption('cx-1')?.status, 'cancelling');
  hr.attemptsOf('cx-1')[0].resolve();
  await flush();
  assert.equal(service.getRedemption('cx-1')?.status, 'completed');
  const after = service.cancel('cx-1');
  assert.equal(after.status, 'completed');
  snapshot = service.snapshot();
  assert.equal(snapshot.employees[0]?.availablePoints, 900);
  assert.equal(snapshot.rewards[0]?.availableStock, 9);
  assert.equal(snapshot.quotaUsage[0]?.used, 1);
  assertSnapshotConsistent(snapshot, EMPLOYEES, REWARDS);
  service.close();
});

test('cancel stops unstarted attempts and cancels once all started attempts fail', async () => {
  const hr = new FakeHr();
  const service = makeService(hr, { retryDelaysMs: [30, 60] });
  service.submit({ redemptionId: 'cx-2', employeeId: 'emp-1', rewardId: 'rw-1' });
  const view = service.cancel('cx-2');
  assert.equal(view.status, 'cancelling');
  await sleep(100);
  assert.equal(hr.attemptCount('cx-2'), 1);
  hr.attemptsOf('cx-2')[0].reject();
  await flush();
  assert.equal(service.getRedemption('cx-2')?.status, 'cancelled');
  const snapshot = service.snapshot();
  assert.equal(snapshot.employees[0]?.availablePoints, 1000);
  assert.equal(snapshot.rewards[0]?.availableStock, 10);
  assert.equal(snapshot.quotaUsage[0]?.used, 0);
  assertSnapshotConsistent(snapshot, EMPLOYEES, REWARDS);
  service.close();
});

test('cancel with no outstanding attempt cancels immediately', async () => {
  const hr = new FakeHr();
  const service = makeService(hr);
  service.submit({ redemptionId: 'cx-3', employeeId: 'emp-1', rewardId: 'rw-1' });
  hr.attemptsOf('cx-3')[0].reject();
  await flush();
  const view = service.cancel('cx-3');
  assert.equal(view.status, 'cancelled');
  const snapshot = service.snapshot();
  assert.equal(snapshot.employees[0]?.availablePoints, 1000);
  assertSnapshotConsistent(snapshot, EMPLOYEES, REWARDS);
  service.close();
});

test('cross-quarter failure refunds into the original quarter slot', async () => {
  const hr = new FakeHr();
  let clock = new Date('2026-01-15T00:00:00Z');
  const service = makeService(hr, {
    retryDelaysMs: [20, 40],
    now: () => clock,
  });
  const submitted = service.submit({ redemptionId: 'xq-1', employeeId: 'emp-1', rewardId: 'rw-1' });
  assert.equal(submitted.redemption?.quarter, '2026-Q1');
  clock = new Date('2026-04-15T00:00:00Z');
  await sleep(70);
  for (const attempt of hr.attemptsOf('xq-1')) attempt.reject();
  await flush();
  assert.equal(service.getRedemption('xq-1')?.status, 'rejected');
  let snapshot = service.snapshot();
  assert.equal(snapshot.quotaUsage[0]?.quarter, '2026-Q1');
  assert.equal(snapshot.quotaUsage[0]?.used, 0);
  assert.equal(snapshot.employees[0]?.availablePoints, 1000);

  const again = service.submit({ redemptionId: 'xq-2', employeeId: 'emp-1', rewardId: 'rw-1' });
  assert.equal(again.accepted, true);
  assert.equal(again.redemption?.quarter, '2026-Q2');
  snapshot = service.snapshot();
  assertSnapshotConsistent(snapshot, EMPLOYEES, REWARDS);
  service.close();
});

test('cross-quarter cancel refunds into the original quarter slot', async () => {
  const hr = new FakeHr();
  let clock = new Date('2026-01-15T00:00:00Z');
  const service = makeService(hr, { now: () => clock });
  service.submit({ redemptionId: 'xq-3', employeeId: 'emp-1', rewardId: 'rw-1' });
  clock = new Date('2026-07-15T00:00:00Z');
  hr.attemptsOf('xq-3')[0].reject();
  await flush();
  const view = service.cancel('xq-3');
  assert.equal(view.status, 'cancelled');
  const snapshot = service.snapshot();
  assert.equal(snapshot.quotaUsage[0]?.quarter, '2026-Q1');
  assert.equal(snapshot.quotaUsage[0]?.used, 0);
  assert.equal(snapshot.employees[0]?.availablePoints, 1000);
  assertSnapshotConsistent(snapshot, EMPLOYEES, REWARDS);
  service.close();
});
