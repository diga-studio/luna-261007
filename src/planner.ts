import { solveOptimalCrew, type Candidate } from "./solve";
import type {
  RecommendResult,
  Worker,
  WorkerOrderContext,
  WorkOrder,
} from "./types";

const MAX_ROSTER = 200;
const MAX_SKILLS_PER_WORKER = 20;
const MAX_REQUIRED_SKILLS = 16;
const DAILY_WORK_LIMIT_MINUTES = 600;

function assertCondition(ok: boolean, message: string): void {
  if (!ok) throw new Error(`crew-planner: ${message}`);
}

function isNonNegativeInteger(v: number): boolean {
  return Number.isInteger(v) && v >= 0;
}

function validateWorker(w: Worker, seen: Set<number>): void {
  assertCondition(
    Number.isInteger(w.id),
    `worker id must be an integer, got ${String(w.id)}`,
  );
  assertCondition(!seen.has(w.id), `duplicate worker id ${w.id}`);
  seen.add(w.id);
  assertCondition(
    Array.isArray(w.skills) && w.skills.length <= MAX_SKILLS_PER_WORKER,
    `worker ${w.id} must have at most ${MAX_SKILLS_PER_WORKER} skills`,
  );
  for (const s of w.skills) {
    assertCondition(
      typeof s.skill === "string" && Number.isFinite(s.certExpiresAt),
      `worker ${w.id} has an invalid skill cert`,
    );
  }
  assertCondition(
    typeof w.leaderCapable === "boolean",
    `worker ${w.id} leaderCapable must be boolean`,
  );
  assertCondition(
    isNonNegativeInteger(w.workedMinutes),
    `worker ${w.id} workedMinutes must be a non-negative integer`,
  );
  assertCondition(
    Number.isInteger(w.creditScore) && w.creditScore >= 0 && w.creditScore <= 100,
    `worker ${w.id} creditScore must be an integer in [0, 100]`,
  );
  assertCondition(
    typeof w.maxOneWayMiles === "number" && w.maxOneWayMiles >= 0,
    `worker ${w.id} maxOneWayMiles must be non-negative`,
  );
  assertCondition(
    Array.isArray(w.avoidedCustomers) &&
      w.avoidedCustomers.every((c) => typeof c === "string"),
    `worker ${w.id} avoidedCustomers must be a string array`,
  );
}

function validateOrder(order: WorkOrder): void {
  assertCondition(
    typeof order.customer === "string",
    "order customer must be a string",
  );
  assertCondition(
    Number.isFinite(order.startAt) && Number.isFinite(order.endAt),
    "order startAt/endAt must be finite timestamps",
  );
  assertCondition(order.endAt > order.startAt, "order endAt must be after startAt");
  assertCondition(
    isNonNegativeInteger(order.workMinutes),
    "order workMinutes must be a non-negative integer",
  );
  assertCondition(
    Array.isArray(order.requiredSkills) &&
      order.requiredSkills.length >= 1 &&
      order.requiredSkills.length <= MAX_REQUIRED_SKILLS &&
      order.requiredSkills.every((s) => typeof s === "string"),
    `order requiredSkills must contain 1..${MAX_REQUIRED_SKILLS} skills`,
  );
}

/**
 * 班组派工推荐器。名册保存在进程内内存中，仅在推荐调用之间整体替换；
 * 每次推荐基于调用时完整的一份名册。
 */
export class CrewPlanner {
  private roster: Worker[] = [];

  /** 整体替换工人名册（至多 200 人）。 */
  replaceRoster(workers: Worker[]): void {
    assertCondition(
      Array.isArray(workers) && workers.length <= MAX_ROSTER,
      `roster must be an array of at most ${MAX_ROSTER} workers`,
    );
    const seen = new Set<number>();
    for (const w of workers) validateWorker(w, seen);
    // 防御性拷贝，避免调用方在两次推荐之间原地修改名册。
    this.roster = workers.map((w) => ({
      ...w,
      skills: w.skills.map((s) => ({ ...s })),
      avoidedCustomers: [...w.avoidedCustomers],
    }));
  }

  /** 为一张工单推荐一支班组；无解时返回 { ok: false }。 */
  recommend(
    order: WorkOrder,
    contexts: WorkerOrderContext[],
  ): RecommendResult {
    validateOrder(order);
    const ctxByWorker = new Map<number, WorkerOrderContext>();
    for (const ctx of contexts) {
      assertCondition(
        Number.isInteger(ctx.workerId),
        "context workerId must be an integer",
      );
      assertCondition(
        !ctxByWorker.has(ctx.workerId),
        `duplicate context for worker ${ctx.workerId}`,
      );
      ctxByWorker.set(ctx.workerId, ctx);
    }

    const required = [...new Set(order.requiredSkills)];
    const skillBit = new Map<string, number>();
    required.forEach((skill, i) => skillBit.set(skill, 1 << i));

    const rosterById = new Map<number, Worker>();
    for (const w of this.roster) rosterById.set(w.id, w);
    for (const id of ctxByWorker.keys()) {
      assertCondition(
        rosterById.has(id),
        `context provided for unknown worker ${id}`,
      );
    }

    const candidates: Candidate[] = [];
    for (const w of this.roster) {
      const ctx = ctxByWorker.get(w.id);
      if (ctx === undefined || !ctx.available) continue;
      if (ctx.oneWayMiles > w.maxOneWayMiles) continue;
      if (w.avoidedCustomers.includes(order.customer)) continue;
      if (w.workedMinutes + order.workMinutes > DAILY_WORK_LIMIT_MINUTES) {
        continue;
      }
      assertCondition(
        isNonNegativeInteger(ctx.roundTripMinutes),
        `worker ${w.id} roundTripMinutes must be a non-negative integer`,
      );

      // 证书到期时刻晚于或等于工单结束时刻，该技能才可计入覆盖；
      // 某项证书失效不影响其他有效技能。
      const expiryBySkill = new Map<string, number>();
      for (const s of w.skills) {
        const prev = expiryBySkill.get(s.skill);
        if (prev === undefined || s.certExpiresAt > prev) {
          expiryBySkill.set(s.skill, s.certExpiresAt);
        }
      }
      let skillMask = 0;
      for (const [skill, bit] of skillBit) {
        const expiry = expiryBySkill.get(skill);
        if (expiry !== undefined && expiry >= order.endAt) skillMask |= bit;
      }

      const cost =
        ctx.roundTripMinutes + w.workedMinutes + (100 - w.creditScore);
      candidates.push({
        id: w.id,
        skillMask,
        leaderCapable: w.leaderCapable,
        cost,
      });
    }

    const requiredMask = (1 << required.length) - 1;
    const outcome = solveOptimalCrew(candidates, requiredMask);
    if (outcome === null) return { ok: false, reason: "no-feasible-crew" };

    const members: number[] = [];
    let bits = outcome.memberMask;
    for (let i = 0; bits !== 0n; i++) {
      if ((bits & 1n) !== 0n) members.push(candidates[i].id);
      bits >>= 1n;
    }
    members.sort((a, b) => a - b);

    // 领班为成员中编号最小的可任领班者。
    let leader = -1;
    for (const id of members) {
      const w = rosterById.get(id);
      if (w !== undefined && w.leaderCapable) {
        leader = id;
        break;
      }
    }

    return { ok: true, members, leader, totalCost: outcome.totalCost };
  }
}
