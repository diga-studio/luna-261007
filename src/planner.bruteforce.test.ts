import { assert, test } from "./testkit";
import { CrewPlanner } from "./planner";
import type {
  RecommendResult,
  Worker,
  WorkerOrderContext,
  WorkOrder,
} from "./types";

/** 确定性伪随机数（mulberry32）。 */
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

const T0 = Date.parse("2026-10-06T08:00:00Z");
const T1 = Date.parse("2026-10-06T12:00:00Z");

interface Fixture {
  workers: Worker[];
  order: WorkOrder;
  contexts: WorkerOrderContext[];
}

function makeFixture(rand: () => number): Fixture {
  const skills = ["a", "b", "c", "d"];
  const nWorkers = 2 + Math.floor(rand() * 7); // 2..8 人
  const nRequired = 1 + Math.floor(rand() * 4); // 1..4 项必需技能
  const required = [...skills].sort(() => rand() - 0.5).slice(0, nRequired);
  const order: WorkOrder = {
    customer: "cust-x",
    startAt: T0,
    endAt: T1,
    workMinutes: Math.floor(rand() * 120),
    requiredSkills: required,
  };
  const workers: Worker[] = [];
  const contexts: WorkerOrderContext[] = [];
  for (let i = 0; i < nWorkers; i++) {
    const id = 1 + Math.floor(rand() * 1000);
    if (workers.some((w) => w.id === id)) continue;
    const wSkills = skills
      .filter(() => rand() < 0.5)
      .map((skill) => ({
        skill,
        // 1/3 概率证书在结束前到期
        certExpiresAt: rand() < 0.33 ? T1 - 1 - Math.floor(rand() * 1000) : T1 + Math.floor(rand() * 1000),
      }));
    workers.push({
      id,
      skills: wSkills,
      leaderCapable: rand() < 0.4,
      workedMinutes: Math.floor(rand() * 500),
      creditScore: Math.floor(rand() * 101),
      maxOneWayMiles: Math.floor(rand() * 60),
      avoidedCustomers: rand() < 0.15 ? ["cust-x"] : [],
    });
    contexts.push({
      workerId: id,
      available: rand() < 0.85,
      oneWayMiles: Math.floor(rand() * 60),
      roundTripMinutes: Math.floor(rand() * 90),
    });
  }
  return { workers, order, contexts };
}

function individualCost(w: Worker, ctx: WorkerOrderContext): number {
  return ctx.roundTripMinutes + w.workedMinutes + (100 - w.creditScore);
}

function eligible(
  w: Worker,
  ctx: WorkerOrderContext,
  order: WorkOrder,
): boolean {
  return (
    ctx.available &&
    ctx.oneWayMiles <= w.maxOneWayMiles &&
    !w.avoidedCustomers.includes(order.customer) &&
    w.workedMinutes + order.workMinutes <= 600
  );
}

function validSkills(w: Worker, order: WorkOrder): Set<string> {
  const out = new Set<string>();
  for (const s of w.skills) {
    if (s.certExpiresAt >= order.endAt) out.add(s.skill);
  }
  return out;
}

function lexCompare(a: number[], b: number[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

/** 暴力枚举全部子集求精确最优，作为参照实现。 */
function bruteForce(f: Fixture): RecommendResult {
  const ctxById = new Map(f.contexts.map((c) => [c.workerId, c]));
  const pool = f.workers.filter((w) => {
    const ctx = ctxById.get(w.id);
    return ctx !== undefined && eligible(w, ctx, f.order);
  });
  let best: { cost: number; members: number[] } | null = null;
  const m = pool.length;
  for (let mask = 0; mask < 1 << m; mask++) {
    const members: Worker[] = [];
    for (let i = 0; i < m; i++) {
      if (mask & (1 << i)) members.push(pool[i]);
    }
    if (members.length < 2 || members.length > 8) continue;
    if (!members.some((w) => w.leaderCapable)) continue;
    const covered = new Set<string>();
    for (const w of members) {
      for (const s of validSkills(w, f.order)) covered.add(s);
    }
    if (!f.order.requiredSkills.every((s) => covered.has(s))) continue;
    const cost = members.reduce(
      (sum, w) => sum + individualCost(w, ctxById.get(w.id)!),
      0,
    );
    const ids = members.map((w) => w.id).sort((a, b) => a - b);
    if (
      best === null ||
      cost < best.cost ||
      (cost === best.cost && ids.length < best.members.length) ||
      (cost === best.cost &&
        ids.length === best.members.length &&
        lexCompare(ids, best.members) < 0)
    ) {
      best = { cost, members: ids };
    }
  }
  if (best === null) return { ok: false, reason: "no-feasible-crew" };
  const leader = best.members.find((id) => {
    const w = f.workers.find((x) => x.id === id);
    return w !== undefined && w.leaderCapable;
  });
  return {
    ok: true,
    members: best.members,
    leader: leader ?? -1,
    totalCost: best.cost,
  };
}

test("随机小规模场景与暴力枚举参照结果完全一致", () => {
  const rand = rng(20261006);
  const planner = new CrewPlanner();
  for (let iter = 0; iter < 500; iter++) {
    const f = makeFixture(rand);
    planner.replaceRoster(f.workers);
    const got = planner.recommend(f.order, f.contexts);
    const want = bruteForce(f);
    assert.deepEqual(got, want);
  }
});
