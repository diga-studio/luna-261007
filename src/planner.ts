import { HOLDING_CAPACITY, isClassCompliant } from './compliance';
import type { Move, PlanInput, PlanResult, RatioCategory } from './types';

/** 调班儿童的位置：0 = 原班，1 = 交接区，2 = 目标班（到达后不再移动） */
const AT_ORIGIN = 0;
const AT_HOLDING = 1;
const AT_TARGET = 2;

interface Mover {
  readonly id: string;
  readonly category: RatioCategory;
  readonly originIndex: number;
  readonly targetIndex: number;
}

/**
 * 求完成全部调班目标的完整移动顺序，移动总次数全局最少。
 * 采用广度优先搜索：每步交接 1 名儿童、代价均为 1，
 * 因此首次到达目标状态的路径即为全局最少移动次数。
 * 不存在合法顺序时返回 { ok: false }。
 * 不修改调用方提供的输入数据。
 */
export function planTransfers(input: PlanInput): PlanResult {
  const classIndexById = new Map<string, number>();
  input.classes.forEach((klass, index) => {
    if (classIndexById.has(klass.id)) {
      throw new Error(`重复的班级 id: ${klass.id}`);
    }
    classIndexById.set(klass.id, index);
  });

  const classIndexOf = (classId: string, childId: string): number => {
    const index = classIndexById.get(classId);
    if (index === undefined) {
      throw new Error(`儿童 ${childId} 引用了不存在的班级: ${classId}`);
    }
    return index;
  };

  // 初始班与目标相同的儿童不得移动，但始终参与人数与比例计算。
  const fixedByClass: RatioCategory[][] = input.classes.map(() => []);
  const movers: Mover[] = [];
  for (const child of input.children) {
    const originIndex = classIndexOf(child.initialClassId, child.id);
    const targetIndex = classIndexOf(child.targetClassId, child.id);
    if (originIndex === targetIndex) {
      fixedByClass[originIndex].push(child.category);
    } else {
      movers.push({ id: child.id, category: child.category, originIndex, targetIndex });
    }
  }

  if (movers.length === 0) {
    return { ok: true, moves: [] };
  }

  // 由状态还原每个班的在班儿童类别，并校验所有班与交接区合规。
  const isCompliant = (locations: readonly number[]): boolean => {
    const present: RatioCategory[][] = fixedByClass.map((fixed) => [...fixed]);
    let holdingCount = 0;
    for (let i = 0; i < movers.length; i += 1) {
      if (locations[i] === AT_ORIGIN) {
        present[movers[i].originIndex].push(movers[i].category);
      } else if (locations[i] === AT_TARGET) {
        present[movers[i].targetIndex].push(movers[i].category);
      } else {
        holdingCount += 1;
      }
    }
    if (holdingCount > HOLDING_CAPACITY) {
      return false;
    }
    for (let c = 0; c < input.classes.length; c += 1) {
      if (!isClassCompliant(input.classes[c].teachers, present[c])) {
        return false;
      }
    }
    return true;
  };

  const start = new Array<number>(movers.length).fill(AT_ORIGIN);
  const startKey = start.join(',');
  const goalKey = new Array<number>(movers.length).fill(AT_TARGET).join(',');

  // parent: 状态 key -> { 前一状态 key, 到达本状态的那一步 }
  const parent = new Map<string, { prevKey: string; move: Move }>();
  const queue: number[][] = [start];
  const visited = new Set<string>([startKey]);
  let goalFound = false;

  for (let head = 0; head < queue.length && !goalFound; head += 1) {
    const current = queue[head];
    const currentKey = current.join(',');
    for (let i = 0; i < movers.length && !goalFound; i += 1) {
      const location = current[i];
      const candidates: { next: number; move: Move }[] = [];
      if (location === AT_ORIGIN) {
        candidates.push({
          next: AT_TARGET,
          move: {
            kind: 'direct',
            childId: movers[i].id,
            fromClassId: input.classes[movers[i].originIndex].id,
            toClassId: input.classes[movers[i].targetIndex].id,
          },
        });
        candidates.push({
          next: AT_HOLDING,
          move: {
            kind: 'toHolding',
            childId: movers[i].id,
            fromClassId: input.classes[movers[i].originIndex].id,
          },
        });
      } else if (location === AT_HOLDING) {
        candidates.push({
          next: AT_TARGET,
          move: {
            kind: 'fromHolding',
            childId: movers[i].id,
            toClassId: input.classes[movers[i].targetIndex].id,
          },
        });
      }
      for (const { next, move } of candidates) {
        const neighbor = [...current];
        neighbor[i] = next;
        const neighborKey = neighbor.join(',');
        if (visited.has(neighborKey) || !isCompliant(neighbor)) {
          continue;
        }
        visited.add(neighborKey);
        parent.set(neighborKey, { prevKey: currentKey, move });
        if (neighborKey === goalKey) {
          goalFound = true;
          break;
        }
        queue.push(neighbor);
      }
    }
  }

  if (!goalFound) {
    return {
      ok: false,
      reason: '无法完成：在交接区容量与师幼比约束下，不存在满足全部目标的合法移动顺序',
    };
  }

  const moves: Move[] = [];
  let key = goalKey;
  while (key !== startKey) {
    const entry = parent.get(key);
    if (!entry) {
      break;
    }
    moves.push(entry.move);
    key = entry.prevKey;
  }
  moves.reverse();
  return { ok: true, moves };
}
