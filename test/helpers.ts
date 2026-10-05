import { RedemptionService } from "../src/index.ts";
import type {
  EmployeeInit,
  RewardInit,
  Snapshot,
} from "../src/index.ts";

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 可控 HR 动作：按兑换ID记录每次尝试，测试可手动令其成功/失败 */
export class HrGate {
  attempts: Array<{ id: string; resolve: () => void; reject: (e: Error) => void }> = [];

  action = (id: string): Promise<void> => {
    return new Promise<void>((resolve, reject) => {
      this.attempts.push({ id, resolve: () => resolve(), reject: (e) => reject(e) });
    });
  };

  attemptsOf(id: string) {
    return this.attempts.filter((a) => a.id === id);
  }

  succeed(id: string, attemptIndex: number): void {
    this.attemptsOf(id)[attemptIndex].resolve();
  }

  fail(id: string, attemptIndex: number): void {
    this.attemptsOf(id)[attemptIndex].reject(new Error("hr delivery failed"));
  }
}

export interface TestRig {
  service: RedemptionService;
  gate: HrGate;
  employees: EmployeeInit[];
  rewards: RewardInit[];
  setTime: (ms: number) => void;
}

export function makeRig(options?: {
  employees?: EmployeeInit[];
  rewards?: RewardInit[];
  retryDelaysMs?: [number, number];
  startTime?: number;
  dbPath?: string;
}): TestRig {
  const employees = options?.employees ?? [{ id: "e1", points: 1000 }];
  const rewards = options?.rewards ?? [{ id: "r1", price: 100, stock: 10 }];
  let currentTime = options?.startTime ?? Date.UTC(2026, 0, 15); // 2026 Q1
  const gate = new HrGate();
  const service = new RedemptionService(options?.dbPath ?? ":memory:", gate.action, {
    retryDelaysMs: options?.retryDelaysMs ?? [50, 100],
    now: () => currentTime,
  });
  service.seed(employees, rewards);
  return {
    service,
    gate,
    employees,
    rewards,
    setTime: (ms) => {
      currentTime = ms;
    },
  };
}

/**
 * 独立重算：根据初始资源与兑换记录推导应有的可用积分/库存/季度占额，
 * 与快照对比，验证一致性（已取消/已拒绝不占资源，其余占用）。
 */
export function assertSnapshotConsistent(
  snapshot: Snapshot,
  initialEmployees: EmployeeInit[],
  initialRewards: RewardInit[],
): void {
  const occupying = new Set(["PENDING", "CANCELLING", "COMPLETED"]);
  const priceOf = new Map(initialRewards.map((r) => [r.id, r.price]));

  const expectedPoints = new Map(initialEmployees.map((e) => [e.id, e.points]));
  const expectedStock = new Map(initialRewards.map((r) => [r.id, r.stock]));
  const expectedUsage = new Map<string, number>();

  for (const rec of snapshot.redemptions) {
    if (!occupying.has(rec.status)) continue;
    expectedPoints.set(
      rec.employeeId,
      (expectedPoints.get(rec.employeeId) ?? 0) - (priceOf.get(rec.rewardId) ?? 0),
    );
    expectedStock.set(rec.rewardId, (expectedStock.get(rec.rewardId) ?? 0) - 1);
    const key = `${rec.employeeId}|${rec.rewardId}|${rec.quarter}`;
    expectedUsage.set(key, (expectedUsage.get(key) ?? 0) + 1);
  }

  for (const e of snapshot.employees) {
    const expected = expectedPoints.get(e.id);
    if (e.availablePoints !== expected) {
      throw new Error(
        `points mismatch for ${e.id}: snapshot=${e.availablePoints} expected=${expected}`,
      );
    }
    if (e.availablePoints < 0) throw new Error(`negative points for ${e.id}`);
  }
  for (const r of snapshot.rewards) {
    const expected = expectedStock.get(r.id);
    if (r.availableStock !== expected) {
      throw new Error(
        `stock mismatch for ${r.id}: snapshot=${r.availableStock} expected=${expected}`,
      );
    }
    if (r.availableStock < 0) throw new Error(`negative stock for ${r.id}`);
  }
  const actualUsage = new Map(
    snapshot.quarterlyUsage.map((u) => [
      `${u.employeeId}|${u.rewardId}|${u.quarter}`,
      u.used,
    ]),
  );
  for (const [key, used] of expectedUsage) {
    if (actualUsage.get(key) !== used) {
      throw new Error(`usage mismatch for ${key}: snapshot=${actualUsage.get(key)} expected=${used}`);
    }
    if (used > 2) throw new Error(`quota exceeded for ${key}`);
  }
  for (const [key, used] of actualUsage) {
    if (expectedUsage.get(key) !== used) {
      throw new Error(`unexpected usage row ${key}: ${used}`);
    }
  }
}
