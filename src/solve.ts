/**
 * 精确最优化核心。
 *
 * 在候选工人上求：覆盖全部必需技能、至少一人可任领班、人数 2..8 的
 * 最低总代价班组。总代价相同时人数少者优先；仍相同时，成员编号升序序列
 * 字典序小者优先。
 *
 * 算法：先按 (有效技能掩码, 是否可任领班) 分组剪枝（组内只留代价最小的
 * 两人），再按 (技能覆盖掩码, 是否含领班, 人数 0..8) 做动态规划。
 * 状态数 2^16 * 2 * 9，每个候选人做一次松弛，复杂度 O(候选数 * 状态数)。
 * 用轮次戳跳过本轮已更新的状态，保证每个候选人至多使用一次。
 * 成员集合用 BigInt 位掩码保存；等人数时比较字典序：对称差最低位在哪边，
 * 哪边的编号升序序列字典序更小（候选人已按编号升序传入，位序即编号序）。
 */

export interface Candidate {
  id: number;
  skillMask: number;
  leaderCapable: boolean;
  cost: number;
}

export interface SolveOutcome {
  /** 第 i 位为 1 表示调用方传入的第 i 个候选入选。 */
  memberMask: bigint;
  totalCost: number;
}

const MAX_SIZE = 8;
const SIZE_DIM = MAX_SIZE + 1;
const SKILL_COUNT = 16;
const INF = Number.POSITIVE_INFINITY;

/** 等 popcount 的两个成员位掩码的字典序比较：a 严格更小返回 true。 */
function lexLess(a: bigint, b: bigint): boolean {
  const diff = a ^ b;
  if (diff === 0n) return false;
  const lowest = diff & -diff;
  return (a & lowest) !== 0n;
}

interface GroupedCandidate extends Candidate {
  sourceIndex: number;
}

/**
 * 同 (技能掩码, 领班标记) 为一组，组内只保留代价最小的两人（并列取编号
 * 小者）。同组其余人永远不会出现在最优班组中：用到他们的方案换成组内更
 * 便宜者必然更优或并列更优；同组至多两人同时入选（仅为满足人数下限 2）。
 */
function pruneDominated(candidates: Candidate[]): GroupedCandidate[] {
  const groups = new Map<number, GroupedCandidate[]>();
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const key = c.skillMask * 2 + (c.leaderCapable ? 1 : 0);
    let list = groups.get(key);
    if (list === undefined) {
      list = [];
      groups.set(key, list);
    }
    list.push({ ...c, sourceIndex: i });
  }
  const out: GroupedCandidate[] = [];
  for (const list of groups.values()) {
    list.sort((a, b) => a.cost - b.cost || a.id - b.id);
    if (list.length > 2) list.length = 2;
    for (const c of list) out.push(c);
  }
  out.sort((a, b) => a.id - b.id);
  return out;
}

export function solveOptimalCrew(
  candidates: Candidate[],
  requiredMask: number,
): SolveOutcome | null {
  const grouped = pruneDominated(candidates);
  const maskCount = 1 << SKILL_COUNT;
  const stateCount = maskCount * 2 * SIZE_DIM;

  const costs = new Float64Array(stateCount).fill(INF);
  const members: Array<bigint> = new Array(stateCount);
  const stamp = new Uint32Array(stateCount);

  const startIdx = (0 * 2 + 0) * SIZE_DIM + 0;
  costs[startIdx] = 0;
  members[startIdx] = 0n;

  for (let ci = 0; ci < grouped.length; ci++) {
    const cand = grouped[ci];
    const bit = 1n << BigInt(ci);
    const round = ci + 1;
    const wMask = cand.skillMask;
    const wLeader = cand.leaderCapable ? 1 : 0;
    const wCost = cand.cost;

    for (let mask = 0; mask < maskCount; mask++) {
      const nMask = mask | wMask;
      for (let leader = 0; leader < 2; leader++) {
        const nLeader = leader | wLeader;
        const base = (mask * 2 + leader) * SIZE_DIM;
        const nBase = (nMask * 2 + nLeader) * SIZE_DIM;
        for (let size = 0; size < MAX_SIZE; size++) {
          const s = base + size;
          if (stamp[s] === round) continue;
          const c = costs[s];
          if (c === INF) continue;
          const t = nBase + size + 1;
          const nCost = c + wCost;
          const oCost = costs[t];
          if (nCost < oCost) {
            costs[t] = nCost;
            members[t] = members[s] | bit;
            stamp[t] = round;
          } else if (nCost === oCost) {
            const candMembers = members[s] | bit;
            if (lexLess(candMembers, members[t])) {
              members[t] = candMembers;
              stamp[t] = round;
            }
          }
        }
      }
    }
  }

  let best = -1;
  for (let size = 2; size <= MAX_SIZE; size++) {
    const t = (requiredMask * 2 + 1) * SIZE_DIM + size;
    const c = costs[t];
    if (c === INF) continue;
    // 按人数升序扫描，代价严格更小才替换：同代价时先扫到的人数更少，已最优。
    if (best === -1 || c < costs[best]) {
      best = t;
    }
  }
  if (best === -1) return null;

  // memberMask 的第 i 位对应 grouped[i]，映射回调用方传入的候选下标。
  let remapped = 0n;
  let bits = members[best];
  for (let gi = 0; bits !== 0n; gi++) {
    if ((bits & 1n) !== 0n) {
      remapped |= 1n << BigInt(grouped[gi].sourceIndex);
    }
    bits >>= 1n;
  }
  return { memberMask: remapped, totalCost: costs[best] };
}
