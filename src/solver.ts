/** 求解器候选工人：已按编号升序、已通过资格过滤。 */
export interface SolverCandidate {
  /** 工人编号。 */
  id: number;
  /** 个人代价：往返行程分钟数 + 当天已排工作分钟数 + (100 - 信用分)。 */
  cost: number;
  /** 该工人可覆盖的必需技能位掩码（bit i 对应必需技能 i）。 */
  skillMask: number;
  /** 是否可任领班。 */
  canLead: boolean;
}

export interface SolverResult {
  /** 成员编号，按数值升序。 */
  memberIds: number[];
  /** 班组总代价。 */
  totalCost: number;
}

const MIN_MEMBERS = 2;
const MAX_MEMBERS = 8;
const SIZE_DIM = MAX_MEMBERS + 1;

/**
 * 精确求解最低总代价班组。
 *
 * 状态为 (已覆盖技能掩码, 人数, 是否已有可任领班者)，DP 保存每个状态的最低代价；
 * 代价相同保留“编号升序序列字典序最小”的成员集合。对人数相同的两个集合，
 * 字典序比较等价于比较成员资格位图中最低的不同位（含该位者更小），
 * 且向两个集合并入同一个不相交集合后该顺序保持不变，因此按状态保留字典序最小路径是正确的。
 *
 * @param candidates 候选工人，必须按 id 升序。
 * @param requiredSkillCount 必需技能数量（1 至 16）。
 */
export function solveMinCostCrew(
  candidates: SolverCandidate[],
  requiredSkillCount: number,
): SolverResult | null {
  const fullMask = (1 << requiredSkillCount) - 1;
  const stateCount = (fullMask + 1) * SIZE_DIM * 2;
  const cost = new Float64Array(stateCount).fill(Infinity);

  // 每个状态的成员位图（bit i = candidates[i]），用于字典序比较与结果还原。
  const pathWords = Math.ceil(candidates.length / 32);
  const path = new Uint32Array(stateCount * pathWords);

  // 每个 (人数, 领班标记) 下已达状态的掩码列表，避免扫描不可达状态。
  const layerCount = SIZE_DIM * 2;
  const reachable = new Int32Array(layerCount * (fullMask + 1));
  const reachableCount = new Int32Array(layerCount);
  const inReachable = new Uint8Array(stateCount);

  const stateIndex = (mask: number, size: number, lead: number): number =>
    (mask * SIZE_DIM + size) * 2 + lead;

  const startIdx = stateIndex(0, 0, 0);
  cost[startIdx] = 0;
  reachable[0] = 0;
  reachableCount[0] = 1;
  inReachable[startIdx] = 1;

  for (let ci = 0; ci < candidates.length; ci++) {
    const cand = candidates[ci]!;
    const cMask = cand.skillMask;
    const cCost = cand.cost;
    const cLead = cand.canLead ? 1 : 0;
    const bitWord = ci >>> 5;
    const bitValue = 1 << (ci & 31);

    // 人数倒序，保证同一工人不会被重复使用。
    for (let size = MAX_MEMBERS - 1; size >= 0; size--) {
      for (let lead = 0; lead <= 1; lead++) {
        const layer = size * 2 + lead;
        const count = reachableCount[layer]!;
        const listBase = layer * (fullMask + 1);
        for (let r = 0; r < count; r++) {
          const mask = reachable[listBase + r]!;
          const idx = stateIndex(mask, size, lead);
          const cur = cost[idx]!;
          const nMask = mask | cMask;
          const nLead = lead | cLead;
          const nIdx = stateIndex(nMask, size + 1, nLead);
          const nCost = cur + cCost;
          const existing = cost[nIdx]!;
          const srcOff = idx * pathWords;
          const dstOff = nIdx * pathWords;
          if (nCost < existing) {
            cost[nIdx] = nCost;
            for (let w = 0; w < pathWords; w++) {
              path[dstOff + w] = path[srcOff + w]!;
            }
            path[dstOff + bitWord] = path[dstOff + bitWord]! | bitValue;
            if (inReachable[nIdx] === 0) {
              inReachable[nIdx] = 1;
              const nLayer = (size + 1) * 2 + nLead;
              const nListBase = nLayer * (fullMask + 1);
              reachable[nListBase + reachableCount[nLayer]!] = nMask;
              reachableCount[nLayer] = reachableCount[nLayer]! + 1;
            }
          } else if (nCost === existing) {
            // 代价相同：仅当新路径字典序更小时替换。
            // 逐字比较“旧路径 | 当前工人位”与已存路径，找最低不同位。
            let replace = false;
            for (let w = 0; w < pathWords; w++) {
              const newWord =
                w === bitWord
                  ? path[srcOff + w]! | bitValue
                  : path[srcOff + w]!;
              const oldWord = path[dstOff + w]!;
              if (newWord !== oldWord) {
                const diff = (newWord ^ oldWord) >>> 0;
                const lowest = (diff & -diff) >>> 0;
                replace = (newWord & lowest) !== 0;
                break;
              }
            }
            if (replace) {
              for (let w = 0; w < pathWords; w++) {
                path[dstOff + w] = path[srcOff + w]!;
              }
              path[dstOff + bitWord] = path[dstOff + bitWord]! | bitValue;
            }
          }
        }
      }
    }
  }

  // 汇总：全覆盖且已有领班，人数 2..8；先比总代价，再比人数，再比字典序。
  let bestIdx = -1;
  let bestCost = Infinity;
  let bestSize = 0;
  for (let size = MIN_MEMBERS; size <= MAX_MEMBERS; size++) {
    const idx = stateIndex(fullMask, size, 1);
    const c = cost[idx]!;
    if (c === Infinity) continue;
    if (c < bestCost || (c === bestCost && size < bestSize)) {
      bestCost = c;
      bestSize = size;
      bestIdx = idx;
    } else if (c === bestCost && size === bestSize) {
      const bOff = bestIdx * pathWords;
      const cOff = idx * pathWords;
      for (let w = 0; w < pathWords; w++) {
        const cw = path[cOff + w]!;
        const bw = path[bOff + w]!;
        if (cw !== bw) {
          const diff = (cw ^ bw) >>> 0;
          const lowest = (diff & -diff) >>> 0;
          if ((cw & lowest) !== 0) bestIdx = idx;
          break;
        }
      }
    }
  }
  if (bestIdx < 0) return null;

  const memberIds: number[] = [];
  const bestOff = bestIdx * pathWords;
  for (let ci = 0; ci < candidates.length; ci++) {
    if ((path[bestOff + (ci >>> 5)]! & (1 << (ci & 31))) !== 0) {
      memberIds.push(candidates[ci]!.id);
    }
  }
  return { memberIds, totalCost: bestCost };
}
