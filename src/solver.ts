import type {
  AllocationRequest,
  AllocationResult,
  CandidateOption,
  DepartmentChoice,
  DepartmentInput,
} from "./types.js";

function assertInteger(value: number, what: string): void {
  if (!Number.isInteger(value)) {
    throw new Error(`${what} 必须是整数，收到 ${value}`);
  }
}

/** 校验并归一化输入；锁定科室的候选被裁剪为仅当前人数。 */
function normalize(request: AllocationRequest): CandidateOption[][] {
  assertInteger(request.targetScore, "目标分");
  if (!Array.isArray(request.departments) || request.departments.length === 0) {
    throw new Error("至少需要一个科室");
  }
  return request.departments.map((dept) => normalizeDepartment(dept));
}

function normalizeDepartment(dept: DepartmentInput): CandidateOption[] {
  if (!dept.id) {
    throw new Error("科室缺少 id");
  }
  assertInteger(dept.currentNurses, `科室 ${dept.id} 当前人数`);
  if (dept.currentNurses < 0) {
    throw new Error(`科室 ${dept.id} 当前人数不能为负`);
  }
  if (!Array.isArray(dept.candidates) || dept.candidates.length === 0) {
    throw new Error(`科室 ${dept.id} 至少需要一个候选人数`);
  }
  const seen = new Set<number>();
  const sorted = [...dept.candidates].sort((a, b) => a.nurses - b.nurses);
  let current: CandidateOption | undefined;
  for (const cand of sorted) {
    assertInteger(cand.nurses, `科室 ${dept.id} 候选人数`);
    assertInteger(cand.score, `科室 ${dept.id} 贡献分`);
    assertInteger(cand.cost, `科室 ${dept.id} 调整费用`);
    if (cand.nurses < 0) {
      throw new Error(`科室 ${dept.id} 候选人数不能为负`);
    }
    if (cand.cost < 0) {
      throw new Error(`科室 ${dept.id} 调整费用不能为负`);
    }
    if (seen.has(cand.nurses)) {
      throw new Error(`科室 ${dept.id} 候选人数 ${cand.nurses} 重复`);
    }
    seen.add(cand.nurses);
    if (cand.nurses === dept.currentNurses) {
      current = cand;
    }
  }
  if (!current) {
    throw new Error(`科室 ${dept.id} 当前人数 ${dept.currentNurses} 不在候选中`);
  }
  if (current.cost !== 0) {
    throw new Error(`科室 ${dept.id} 当前人数对应费用必须为 0`);
  }
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i].score < sorted[i - 1].score) {
      throw new Error(`科室 ${dept.id} 人数增加时贡献分不能下降`);
    }
  }
  if (dept.locked) {
    return [current];
  }
  return sorted;
}

interface DpState {
  cost: number;
  changes: number;
  /** 上一状态在上一层数组中的 key，初始状态为 null。 */
  prevKey: string | null;
  /** 本科室选择的候选下标，初始状态为 -1。 */
  choiceIndex: number;
}

function better(candidate: DpState, existing: DpState): boolean {
  if (candidate.cost !== existing.cost) return candidate.cost < existing.cost;
  return candidate.changes < existing.changes;
}

/**
 * 计算达标的最优调配建议。
 * 约束：总人数守恒、锁定科室不变、总分 >= 目标。
 * 优化顺序：先总费用最低，再改动科室数最少。
 */
export function solveAllocation(request: AllocationRequest): AllocationResult {
  const target = request.targetScore;
  const departments = normalize(request);

  // DP 状态键：`净人数变化|min(累计分, 目标)`。分数超过目标后对可行性无差别，钳制以压缩状态。
  const startKey = "0|0";
  let layer = new Map<string, DpState>([
    [startKey, { cost: 0, changes: 0, prevKey: null, choiceIndex: -1 }],
  ]);
  const layers: Map<string, DpState>[] = [layer];

  departments.forEach((candidates, deptIndex) => {
    const prevLayer = layers[deptIndex];
    const next = new Map<string, DpState>();
    for (const [key, state] of prevLayer) {
      const [deltaText, scoreText] = key.split("|");
      const delta = Number(deltaText);
      const score = Number(scoreText);
      candidates.forEach((cand, choiceIndex) => {
        const nextDelta = delta + cand.nurses - request.departments[deptIndex].currentNurses;
        const nextScore = Math.min(score + cand.score, target);
        const nextState: DpState = {
          cost: state.cost + cand.cost,
          changes: state.changes + (choiceIndex >= 0 && cand.nurses === request.departments[deptIndex].currentNurses ? 0 : 1),
          prevKey: key,
          choiceIndex,
        };
        const nextKey = `${nextDelta}|${nextScore}`;
        const existing = next.get(nextKey);
        if (!existing || better(nextState, existing)) {
          next.set(nextKey, nextState);
        }
      });
    }
    layers.push(next);
    layer = next;
  });

  // 终点：净人数变化为 0 且（钳制后）分数达到目标。
  let bestKey: string | null = null;
  let bestState: DpState | null = null;
  for (const [key, state] of layer) {
    if (!key.startsWith("0|")) continue;
    if (Number(key.split("|")[1]) < target) continue;
    if (!bestState || better(state, bestState)) {
      bestKey = key;
      bestState = state;
    }
  }
  if (!bestKey || !bestState) {
    return {
      feasible: false,
      reason: `在人数守恒与锁定限制下，没有任何候选组合能使总分达到目标 ${target}`,
    };
  }

  // 回溯每个科室的选择。
  const choiceIndexes = new Array<number>(departments.length);
  let walkKey: string | null = bestKey;
  for (let deptIndex = departments.length - 1; deptIndex >= 0; deptIndex -= 1) {
    const state: DpState = layers[deptIndex + 1].get(walkKey as string)!;
    choiceIndexes[deptIndex] = state.choiceIndex;
    walkKey = state.prevKey;
  }

  const changes: DepartmentChoice[] = [];
  let totalScore = 0;
  let totalCost = 0;
  departments.forEach((candidates, deptIndex) => {
    const dept = request.departments[deptIndex];
    const chosen = candidates[choiceIndexes[deptIndex]];
    const current = candidates.find((cand) => cand.nurses === dept.currentNurses)!;
    totalScore += chosen.score;
    totalCost += chosen.cost;
    if (chosen.nurses !== dept.currentNurses) {
      changes.push({
        id: dept.id,
        fromNurses: dept.currentNurses,
        toNurses: chosen.nurses,
        scoreDelta: chosen.score - current.score,
        cost: chosen.cost,
      });
    }
  });

  const explanation = buildExplanation(changes, totalScore, target, totalCost);
  return {
    feasible: true,
    changes,
    totalScore,
    totalCost,
    changedDepartments: changes.length,
    explanation,
  };
}

function buildExplanation(
  changes: DepartmentChoice[],
  totalScore: number,
  target: number,
  totalCost: number,
): string {
  const lines: string[] = [];
  if (changes.length === 0) {
    lines.push(`当前配置已达标：总分 ${totalScore} ≥ 目标 ${target}，无需调整。`);
    return lines.join("\n");
  }
  lines.push("调整方案（按科室）：");
  for (const change of changes) {
    const delta = change.toNurses - change.fromNurses;
    const sign = delta > 0 ? "+" : "";
    lines.push(
      `- ${change.id}：${change.fromNurses} → ${change.toNurses} 人（${sign}${delta}），` +
        `贡献分 +${change.scoreDelta}，调整费用 ${change.cost} 分`,
    );
  }
  lines.push(
    `调整后总分 ${totalScore} ≥ 目标 ${target}；总费用 ${totalCost} 分，涉及 ${changes.length} 个科室。`,
  );
  return lines.join("\n");
}
