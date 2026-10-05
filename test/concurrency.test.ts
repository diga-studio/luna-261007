import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { RedemptionService } from '../src/index.ts';
import { FakeHr, assertSnapshotConsistent, deferred, flush } from './helpers.ts';

function makeEmployees(count: number, points: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `emp-${index}`,
    points,
  }));
}

function makeRewards(count: number, price: number, stock: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `rw-${index}`,
    price,
    stock,
  }));
}

test('32 employees race for the last stock unit, exactly one wins', async () => {
  const employees = makeEmployees(32, 100);
  const rewards = [{ id: 'rw-hot', price: 10, stock: 1 }];
  const hr = new FakeHr();
  const service = new RedemptionService({
    employees,
    rewards,
    hrHandler: hr.handler,
    retryDelaysMs: [600_000, 1_200_000],
  });
  const results = await Promise.all(
    employees.map((employee, index) =>
      Promise.resolve().then(() =>
        service.submit({
          redemptionId: `race-${index}`,
          employeeId: employee.id,
          rewardId: 'rw-hot',
        }),
      ),
    ),
  );
  const winners = results.filter((result) => result.accepted);
  const losers = results.filter((result) => !result.accepted);
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 31);
  assert.ok(losers.every((result) => result.reason === 'OUT_OF_STOCK'));

  const snapshot = service.snapshot();
  assert.equal(snapshot.rewards[0]?.availableStock, 0);
  const winnerId = winners[0]!.redemption!.employeeId;
  for (const row of snapshot.employees) {
    assert.equal(row.availablePoints, row.employeeId === winnerId ? 90 : 100);
  }
  assertSnapshotConsistent(snapshot, employees, rewards);
  service.close();
});

test('concurrent submissions race for the last quarterly quota slot', async () => {
  const employees = [{ id: 'emp-1', points: 1000 }];
  const rewards = [{ id: 'rw-1', price: 10, stock: 50 }];
  const hr = new FakeHr();
  const service = new RedemptionService({
    employees,
    rewards,
    hrHandler: hr.handler,
    retryDelaysMs: [600_000, 1_200_000],
  });
  service.submit({ redemptionId: 'pre-1', employeeId: 'emp-1', rewardId: 'rw-1' });
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      Promise.resolve().then(() =>
        service.submit({
          redemptionId: `quota-race-${index}`,
          employeeId: 'emp-1',
          rewardId: 'rw-1',
        }),
      ),
    ),
  );
  const winners = results.filter((result) => result.accepted);
  const losers = results.filter((result) => !result.accepted);
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 7);
  assert.ok(losers.every((result) => result.reason === 'QUOTA_EXCEEDED'));

  const snapshot = service.snapshot();
  assert.equal(snapshot.quotaUsage[0]?.used, 2);
  assert.equal(snapshot.employees[0]?.availablePoints, 980);
  assertSnapshotConsistent(snapshot, employees, rewards);
  service.close();
});

test('32 independent redemptions start their first HR attempt within 500ms', async () => {
  const employees = makeEmployees(500, 100);
  const rewards = makeRewards(100, 10, 50);
  const startedAt: number[] = [];
  const service = new RedemptionService({
    employees,
    rewards,
    hrHandler: () => {
      startedAt.push(performance.now());
      return deferred().promise;
    },
    retryDelaysMs: [600_000, 1_200_000],
  });
  const begin = performance.now();
  for (let index = 0; index < 32; index += 1) {
    service.submit({
      redemptionId: `burst-${index}`,
      employeeId: `emp-${index}`,
      rewardId: `rw-${index}`,
    });
  }
  assert.equal(startedAt.length, 32);
  const lastStarted = Math.max(...startedAt);
  assert.ok(
    lastStarted - begin < 500,
    `first attempts took ${lastStarted - begin}ms to all start`,
  );
  assertSnapshotConsistent(service.snapshot(), employees, rewards);
  service.close();
});

test('slow HR actions do not block submit, cancel, query or snapshot', async () => {
  const employees = makeEmployees(500, 100);
  const rewards = makeRewards(100, 10, 50);
  const gate = deferred();
  const service = new RedemptionService({
    employees,
    rewards,
    hrHandler: () => gate.promise,
    retryDelaysMs: [600_000, 1_200_000],
  });
  service.submit({ redemptionId: 'slow-1', employeeId: 'emp-0', rewardId: 'rw-0' });

  const timed = <T>(action: () => T): { value: T; elapsed: number } => {
    const start = performance.now();
    const value = action();
    return { value, elapsed: performance.now() - start };
  };

  const submitted = timed(() =>
    service.submit({ redemptionId: 'slow-2', employeeId: 'emp-1', rewardId: 'rw-1' }),
  );
  assert.ok(submitted.elapsed < 100, `submit took ${submitted.elapsed}ms`);
  assert.equal(submitted.value.accepted, true);

  const queried = timed(() => service.getRedemption('slow-1'));
  assert.ok(queried.elapsed < 100, `query took ${queried.elapsed}ms`);
  assert.equal(queried.value?.status, 'pending');

  const cancelled = timed(() => service.cancel('slow-1'));
  assert.ok(cancelled.elapsed < 100, `cancel took ${cancelled.elapsed}ms`);
  assert.equal(cancelled.value.status, 'cancelling');

  const snapped = timed(() => service.snapshot());
  assert.ok(snapped.elapsed < 100, `snapshot took ${snapped.elapsed}ms`);
  assert.equal(
    snapped.value.redemptions.find((row) => row.id === 'slow-1')?.status,
    'cancelling',
  );
  assertSnapshotConsistent(snapped.value, employees, rewards);

  gate.resolve();
  await flush();
  assert.equal(service.getRedemption('slow-1')?.status, 'completed');
  assertSnapshotConsistent(service.snapshot(), employees, rewards);
  service.close();
});
