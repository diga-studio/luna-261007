import assert from 'node:assert/strict';
import type { EmployeeSeed, RewardSeed, Snapshot } from '../src/index.ts';

export interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error?: Error) => void;
}

export function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error?: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export class FakeHr {
  readonly calls: string[] = [];
  private readonly pending = new Map<string, Deferred[]>();
  private behavior: ((id: string) => Promise<void>) | null = null;

  setBehavior(behavior: (id: string) => Promise<void>): void {
    this.behavior = behavior;
  }

  handler = (id: string): Promise<void> => {
    this.calls.push(id);
    if (this.behavior) return this.behavior(id);
    const attempt = deferred();
    const list = this.pending.get(id) ?? [];
    list.push(attempt);
    this.pending.set(id, list);
    return attempt.promise;
  };

  attemptsOf(id: string): Deferred[] {
    return this.pending.get(id) ?? [];
  }

  attemptCount(id: string): number {
    return this.calls.filter((call) => call === id).length;
  }
}

export async function flush(rounds = 5): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await Promise.resolve();
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const HELD_STATUSES = new Set(['pending', 'cancelling', 'completed']);

export function assertSnapshotConsistent(
  snapshot: Snapshot,
  employees: EmployeeSeed[],
  rewards: RewardSeed[],
): void {
  const priceOf = new Map(rewards.map((reward) => [reward.id, reward.price]));
  const expectedPoints = new Map(employees.map((employee) => [employee.id, employee.points]));
  const expectedStock = new Map(rewards.map((reward) => [reward.id, reward.stock]));
  const expectedQuota = new Map<string, number>();

  for (const redemption of snapshot.redemptions) {
    if (!HELD_STATUSES.has(redemption.status)) continue;
    const price = priceOf.get(redemption.rewardId);
    assert.ok(price !== undefined, `unknown reward ${redemption.rewardId}`);
    expectedPoints.set(
      redemption.employeeId,
      (expectedPoints.get(redemption.employeeId) ?? 0) - price,
    );
    expectedStock.set(
      redemption.rewardId,
      (expectedStock.get(redemption.rewardId) ?? 0) - 1,
    );
    const key = `${redemption.employeeId}|${redemption.rewardId}|${redemption.quarter}`;
    expectedQuota.set(key, (expectedQuota.get(key) ?? 0) + 1);
  }

  for (const row of snapshot.employees) {
    assert.equal(
      row.availablePoints,
      expectedPoints.get(row.employeeId) ?? 0,
      `points mismatch for ${row.employeeId}`,
    );
    assert.ok(row.availablePoints >= 0, `negative points for ${row.employeeId}`);
  }
  for (const row of snapshot.rewards) {
    assert.equal(
      row.availableStock,
      expectedStock.get(row.rewardId) ?? 0,
      `stock mismatch for ${row.rewardId}`,
    );
    assert.ok(row.availableStock >= 0, `negative stock for ${row.rewardId}`);
  }
  for (const row of snapshot.quotaUsage) {
    const key = `${row.employeeId}|${row.rewardId}|${row.quarter}`;
    assert.equal(row.used, expectedQuota.get(key) ?? 0, `quota mismatch for ${key}`);
    assert.ok(row.used <= 2, `quota above two for ${key}`);
  }
  const reportedKeys = new Set(
    snapshot.quotaUsage.map((row) => `${row.employeeId}|${row.rewardId}|${row.quarter}`),
  );
  for (const key of expectedQuota.keys()) {
    assert.ok(reportedKeys.has(key), `quota row missing for ${key}`);
  }
}
