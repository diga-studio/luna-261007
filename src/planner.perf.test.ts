import { assert, test } from "./testkit";
import { CrewPlanner } from "./planner";
import type { Worker, WorkerOrderContext, WorkOrder } from "./types";

const T0 = Date.parse("2026-10-06T08:00:00Z");
const T1 = Date.parse("2026-10-06T12:00:00Z");
const SKILLS = Array.from({ length: 16 }, (_, i) => `s${i}`);
const TIME_LIMIT_MS = 5000;
const MEM_LIMIT_BYTES = 256 * 1024 * 1024;

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gc(): void {
  const g = (globalThis as { gc?: () => void }).gc;
  if (g !== undefined) g();
}

interface PerfResult {
  ok: boolean;
  members?: number[];
  leader?: number;
  totalCost?: number;
  elapsedMs: number;
  heapDeltaBytes: number;
}

function runTimed(
  planner: CrewPlanner,
  order: WorkOrder,
  contexts: WorkerOrderContext[],
): PerfResult {
  gc();
  const heapBefore = process.memoryUsage().heapUsed;
  const t0 = Date.now();
  const res = planner.recommend(order, contexts);
  const elapsedMs = Date.now() - t0;
  // 不 gc 直接测，近似包含推荐过程中的峰值堆占用。
  const heapDeltaBytes = process.memoryUsage().heapUsed - heapBefore;
  if (!res.ok) return { ok: false, elapsedMs, heapDeltaBytes };
  return {
    ok: true,
    members: res.members,
    leader: res.leader,
    totalCost: res.totalCost,
    elapsedMs,
    heapDeltaBytes,
  };
}

/**
 * 构造 200 人名册：8 名“设计工人”各覆盖一对技能、代价 10、可任领班；
 * 192 名填充工人从少量共享技能组合中抽取（大量共享技能），代价 >= 100。
 * 已知最优：{1000..1007}，总代价 80，领班 1000。
 */
function makeSolvableFixture(): {
  workers: Worker[];
  contexts: WorkerOrderContext[];
  order: WorkOrder;
} {
  const rand = rng(991);
  const workers: Worker[] = [];
  for (let k = 0; k < 8; k++) {
    workers.push({
      id: 1000 + k,
      skills: [
        { skill: SKILLS[2 * k], certExpiresAt: T1 + 1000 },
        { skill: SKILLS[2 * k + 1], certExpiresAt: T1 + 1000 },
      ],
      leaderCapable: true,
      workedMinutes: 0,
      creditScore: 90, // 代价 10
      maxOneWayMiles: 1000,
      avoidedCustomers: [],
    });
  }
  // 少量共享技能组合，192 名填充工人大量共享。
  const sharedMasks: string[][] = [];
  for (let m = 0; m < 12; m++) {
    const combo: string[] = [];
    for (let j = 0; j < 4; j++) combo.push(SKILLS[(m * 4 + j) % 16]);
    sharedMasks.push(combo);
  }
  for (let i = 0; i < 192; i++) {
    const combo = sharedMasks[i % sharedMasks.length];
    workers.push({
      id: 2000 + i,
      skills: combo.map((skill) => ({ skill, certExpiresAt: T1 + 1000 })),
      leaderCapable: i % 3 === 0,
      workedMinutes: Math.floor(rand() * 100),
      creditScore: Math.floor(rand() * 51), // 代价 >= 50 + 往返
      maxOneWayMiles: 1000,
      avoidedCustomers: [],
    });
  }
  const contexts: WorkerOrderContext[] = workers.map((w) => ({
    workerId: w.id,
    available: true,
    oneWayMiles: 0,
    roundTripMinutes: w.id >= 2000 ? 50 + Math.floor(rand() * 100) : 0,
  }));
  const order: WorkOrder = {
    customer: "cust-perf",
    startAt: T0,
    endAt: T1,
    workMinutes: 60,
    requiredSkills: [...SKILLS],
  };
  return { workers, contexts, order };
}

test("200 人 / 16 项必需技能 / 大量共享技能：有解且为已知最优", () => {
  const { workers, contexts, order } = makeSolvableFixture();
  const planner = new CrewPlanner();
  planner.replaceRoster(workers);
  const r = runTimed(planner, order, contexts);
  assert.ok(r.ok, "expected a feasible crew");
  assert.deepEqual(r.members, [1000, 1001, 1002, 1003, 1004, 1005, 1006, 1007]);
  assert.equal(r.leader, 1000);
  assert.equal(r.totalCost, 80);
  assert.ok(
    r.elapsedMs < TIME_LIMIT_MS,
    `recommend took ${r.elapsedMs}ms, limit ${TIME_LIMIT_MS}ms`,
  );
  assert.ok(
    r.heapDeltaBytes < MEM_LIMIT_BYTES,
    `heap delta ${r.heapDeltaBytes} bytes exceeds 256 MiB`,
  );
  process.stdout.write(
    `    [perf] solvable: ${r.elapsedMs}ms, heap +${(r.heapDeltaBytes / 1048576).toFixed(1)} MiB\n`,
  );
});

test("200 人 / 16 项必需技能：无解场景同样快速明确返回", () => {
  const { workers, contexts, order } = makeSolvableFixture();
  // 让技能 s15 无人持有（设计工人 1007 改持 s0），其余不变。
  for (const w of workers) {
    if (w.id === 1007) {
      w.skills = [
        { skill: "s14", certExpiresAt: T1 + 1000 },
        { skill: "s0", certExpiresAt: T1 + 1000 },
      ];
    } else {
      w.skills = w.skills.filter((s) => s.skill !== "s15");
    }
  }
  const planner = new CrewPlanner();
  planner.replaceRoster(workers);
  const r = runTimed(planner, order, contexts);
  assert.equal(r.ok, false);
  assert.ok(
    r.elapsedMs < TIME_LIMIT_MS,
    `recommend took ${r.elapsedMs}ms, limit ${TIME_LIMIT_MS}ms`,
  );
  assert.ok(
    r.heapDeltaBytes < MEM_LIMIT_BYTES,
    `heap delta ${r.heapDeltaBytes} bytes exceeds 256 MiB`,
  );
  process.stdout.write(
    `    [perf] unsolvable: ${r.elapsedMs}ms, heap +${(r.heapDeltaBytes / 1048576).toFixed(1)} MiB\n`,
  );
});
