import type {
  CandidateOption,
  DepartmentChange,
  DepartmentInput,
  StaffingAdvice,
} from "./types.js";

interface DpState {
  /** 累计贡献分（相对当前配置的净增益） */
  score: number;
  /** 累计调整费用 */
  cost: number;
  /** 人数发生变化的科室数 */
  changes: number;
  /** 上一状态（回溯用） */
  prev: DpState | null;
  /** 本科室选择的候选下标 */
  choice: number;
}

function validate(departments: DepartmentInput[]): void {
  for (const dept of departments) {
    const seen = new Set<number>();
    let current: CandidateOption | undefined;
    for (const c of dept.candidates) {
      if (!Number.isInteger(c.headcount) || c.headcount < 0) {
        throw new Error(`科室 ${dept.id} 的候选人数必须是非负整数`);
      }
      if (!Number.isInteger(c.score)) {
        throw new Error(`科室 ${dept.id} 的贡献分必须是整数`);
      }
      if (!Number.isInteger(c.cost) || c.cost < 0) {
        throw new Error(`科室 ${dept.id} 的调整费用必须是非负整数`);
      }
      if (seen.has(c.headcount)) {
        throw new Error(`科室 ${dept.id} 的候选人数 ${c.headcount} 重复`);
      }
      seen.add(c.headcount);
      if (c.headcount === dept.currentHeadcount) current = c;
    }
    if (!current) {
      throw new Error(`科室 ${dept.id} 的当前人数不在候选集合中`);
    }
    if (current.cost !== 0) {
      throw new Error(`科室 ${dept.id} 当前配置的调整费用必须为 0`);
    }
    const sorted = [...dept.candidates].sort((a, b) => a.headcount - b.headcount);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].score < sorted[i - 1].score) {
        throw new Error(`科室 ${dept.id} 的贡献分必须随人数不下降`);
      }
    }
  }
}

/** 在 (cost, changes) 字典序下更优则返回 true */
function better(costA: number, changesA: number, costB: number, changesB: number): boolean {
  return costA < costB || (costA === costB && changesA < changesB);
}

/**
 * 在护士总量不变的前提下，为每个科室选择恰好一个候选人数，
 * 使总分达到 targetScore；达标组合中先最小化总费用，再最小化改动科室数。
 */
export function suggestStaffing(
  departments: DepartmentInput[],
  targetScore: number,
): StaffingAdvice {
  if (!Number.isInteger(targetScore)) {
    throw new Error("目标分必须是整数");
  }
  validate(departments);

  const currentTotal = departments.reduce((sum, d) => {
    const cur = d.candidates.find((c) => c.headcount === d.currentHeadcount)!;
    return sum + cur.score;
  }, 0);
  const need = targetScore - currentTotal;

  // 当前配置已经达标：返回不作调整的建议
  if (need <= 0) {
    return {
      reachable: true,
      targetScore,
      totalScore: currentTotal,
      totalCost: 0,
      changedDepartments: 0,
      changes: [],
      summary: `当前配置总分 ${currentTotal} 已达到目标 ${targetScore}，无需调整。`,
    };
  }

  // DP：key 为净人数变化（选择人数 - 当前人数 的累计值）
  // 每个 delta 下按截断分保留帕累托最优状态
  let layer = new Map<number, Map<number, DpState>>();
  const initial = new Map<number, DpState>();
  initial.set(0, { score: 0, cost: 0, changes: 0, prev: null, choice: -1 });
  layer.set(0, initial);

  departments.forEach((dept) => {
    const cur = dept.candidates.find((c) => c.headcount === dept.currentHeadcount)!;
    const options = dept.locked ? [cur] : dept.candidates;
    const next = new Map<number, Map<number, DpState>>();
    for (const [delta, byScore] of layer) {
      for (const state of byScore.values()) {
        for (let ci = 0; ci < options.length; ci++) {
          const opt = options[ci];
          const nd = delta + opt.headcount - dept.currentHeadcount;
          const changed = opt.headcount !== dept.currentHeadcount ? 1 : 0;
          // 注意：不能对 score 按 need 截断，后续科室可能有负收益，截断会丢失信息
          const cand: DpState = {
            score: state.score + opt.score - cur.score,
            cost: state.cost + opt.cost,
            changes: state.changes + changed,
            prev: state,
            choice: dept.candidates.indexOf(opt),
          };
          let bucket = next.get(nd);
          if (!bucket) {
            bucket = new Map();
            next.set(nd, bucket);
          }
          const existing = bucket.get(cand.score);
          if (!existing || better(cand.cost, cand.changes, existing.cost, existing.changes)) {
            bucket.set(cand.score, cand);
          }
        }
      }
    }
    // 支配剪枝：按分数降序处理，若已保留状态的费用与改动数都不更高，则淘汰当前状态
    for (const bucket of next.values()) {
      const entries = [...bucket.values()].sort((a, b) => b.score - a.score);
      const kept: DpState[] = [];
      for (const st of entries) {
        if (kept.some((k) => k.cost <= st.cost && k.changes <= st.changes)) continue;
        kept.push(st);
      }
      bucket.clear();
      for (const k of kept) bucket.set(k.score, k);
    }
    layer = next;
  });

  const finalBucket = layer.get(0);
  let best: DpState | undefined;
  if (finalBucket) {
    for (const state of finalBucket.values()) {
      if (state.score >= need && (!best || better(state.cost, state.changes, best.cost, best.changes))) {
        best = state;
      }
    }
  }

  if (!best) {
    return {
      reachable: false,
      targetScore,
      totalScore: 0,
      totalCost: 0,
      changedDepartments: 0,
      changes: [],
      summary: `目标 ${targetScore} 不可达：在人数守恒与锁定限制下没有任何组合能达标。`,
    };
  }

  // 回溯每个科室选择的候选
  const choices: number[] = new Array(departments.length);
  let cursor: DpState | null = best;
  for (let i = departments.length - 1; i >= 0; i--) {
    choices[i] = cursor!.choice;
    cursor = cursor!.prev;
  }

  const changes: DepartmentChange[] = [];
  let totalScore = 0;
  let totalCost = 0;
  departments.forEach((dept, i) => {
    const cur = dept.candidates.find((c) => c.headcount === dept.currentHeadcount)!;
    const chosen = dept.candidates[choices[i]];
    totalScore += chosen.score;
    totalCost += chosen.cost;
    if (chosen.headcount !== dept.currentHeadcount) {
      changes.push({
        departmentId: dept.id,
        fromHeadcount: dept.currentHeadcount,
        toHeadcount: chosen.headcount,
        scoreGain: chosen.score - cur.score,
        cost: chosen.cost,
      });
    }
  });

  const detail = changes
    .map(
      (c) =>
        `科室 ${c.departmentId}：${c.fromHeadcount} → ${c.toHeadcount} 人` +
        `（贡献分 ${c.scoreGain >= 0 ? "+" : ""}${c.scoreGain}，费用 ${c.cost}）`,
    )
    .join("；");
  return {
    reachable: true,
    targetScore,
    totalScore,
    totalCost,
    changedDepartments: changes.length,
    changes,
    summary:
      `达标建议：总分 ${totalScore}（目标 ${targetScore}），总费用 ${totalCost}，` +
      `调整 ${changes.length} 个科室。${detail}`,
  };
}
