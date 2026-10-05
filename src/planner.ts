import {
  CrewRecommendation,
  Worker,
  WorkerAssignmentContext,
  WorkOrder,
} from "./types";
import { solveMinCostCrew, SolverCandidate } from "./solver";

/** 当天已排工作分钟数加上本次工作分钟数的上限。 */
const MAX_DAILY_WORK_MINUTES = 600;
/** 同一 (技能掩码, 代价, 领班标记) 完全等价的工人，保留编号最小的人数上限（班组人数上限）。 */
const IDENTICAL_CANDIDATE_KEEP = 8;

/**
 * 班组派工推荐器。名册保存在进程内内存中，仅在推荐调用之间整体替换。
 */
export class CrewPlanner {
  private roster: Worker[] = [];

  /**
   * 整体替换工人名册。
   */
  replaceRoster(workers: Worker[]): void {
    this.roster = workers.slice();
  }

  /**
   * 为一张工单推荐一支班组。
   *
   * @param order 工单。
   * @param context 上层为每位工人提供的可用结论、单程里程与往返分钟数，按工人编号索引。
   * @returns 最低总代价的合法班组；没有合法班组时返回 null。
   */
  recommendCrew(
    order: WorkOrder,
    context: Readonly<Record<number, WorkerAssignmentContext>>,
  ): CrewRecommendation | null {
    const skillIndex = new Map<string, number>();
    order.requiredSkills.forEach((skill, i) => skillIndex.set(skill, i));

    // 资格过滤并构造候选，按编号升序。
    const sorted = this.roster.slice().sort((a, b) => a.id - b.id);
    const candidates: SolverCandidate[] = [];
    for (const worker of sorted) {
      const ctx = context[worker.id];
      if (ctx === undefined || !ctx.available) continue;
      if (ctx.oneWayMiles > worker.oneWayRadiusMiles) continue;
      if (worker.avoidedClients.includes(order.client)) continue;
      if (worker.workedMinutes + order.workMinutes > MAX_DAILY_WORK_MINUTES) {
        continue;
      }
      let skillMask = 0;
      for (const cert of worker.skills) {
        if (cert.certExpiresAt < order.endsAt) continue;
        const bit = skillIndex.get(cert.skill);
        if (bit !== undefined) skillMask |= 1 << bit;
      }
      candidates.push({
        id: worker.id,
        cost: ctx.roundTripMinutes + worker.workedMinutes + (100 - worker.creditScore),
        skillMask,
        canLead: worker.canLead,
      });
    }

    // 完全等价（技能掩码、代价、领班标记均相同）的工人只留编号最小的 8 个：
    // 班组至多 8 人，更多等价工人不可能同时入选，且编号更小者字典序不劣。
    const groupKeep = new Map<string, number>();
    const pruned: SolverCandidate[] = [];
    for (const cand of candidates) {
      const key = `${cand.skillMask}|${cand.cost}|${cand.canLead ? 1 : 0}`;
      const kept = groupKeep.get(key) ?? 0;
      if (kept >= IDENTICAL_CANDIDATE_KEEP) continue;
      groupKeep.set(key, kept + 1);
      pruned.push(cand);
    }

    const result = solveMinCostCrew(pruned, skillIndex.size);
    if (result === null) return null;

    // 领班：成员中编号最小的可任领班者。
    const canLeadById = new Map<number, boolean>();
    for (const worker of this.roster) canLeadById.set(worker.id, worker.canLead);
    let foremanId = -1;
    for (const id of result.memberIds) {
      if (canLeadById.get(id) === true) {
        foremanId = id;
        break;
      }
    }

    return {
      memberIds: result.memberIds,
      foremanId,
      totalCost: result.totalCost,
    };
  }
}
