import { intersectSpans, mergeSpans, subtractSpans } from './intervals';
import type { Span } from './intervals';
import { applyAdjustments } from './snapshot';
import type { CandidateView, Snapshot } from './snapshot';
import type {
  Adjustment,
  ConflictSegment,
  EmployeeId,
  OrgNodeId,
  Policy,
  ResourceId,
  RoleId,
  TimeRange,
} from './types';

/** 预检查询范围上限：10 年（按 365 天/年计）。 */
export const MAX_RANGE_MS = 10 * 365 * 24 * 60 * 60 * 1000;

const KEY_SHIFT = 20; // 每个资源下可区分 2^20 个角色
const keyOf = (resourceIdx: number, roleIdx: number): number =>
  resourceIdx * 2 ** KEY_SHIFT + roleIdx;

interface CanonicalPair {
  roleA: RoleId;
  roleB: RoleId;
  roleAIdx: number;
  roleBIdx: number;
}

function validateRange(range: TimeRange): void {
  if (!Number.isInteger(range.start) || !Number.isInteger(range.end)) {
    throw new Error('查询范围必须是整数毫秒');
  }
  if (range.end <= range.start) {
    throw new Error('查询范围的 end 必须大于 start');
  }
  if (range.end - range.start > MAX_RANGE_MS) {
    throw new Error(`查询范围超过上限（最长 10 年）`);
  }
}

function clipSpan(start: number, end: number | undefined, range: TimeRange): Span | null {
  const s = Math.max(start, range.start);
  const e = Math.min(end === undefined ? range.end : end, range.end);
  return s < e ? { start: s, end: e } : null;
}

/**
 * 对整组调整完成后的候选方案做职责分离预检。
 * 返回查询范围内所有未被豁免覆盖的冲突，按员工/资源/角色对输出最大连续时段。
 */
export function precheck(
  snapshot: Snapshot,
  adjustments: ReadonlyArray<Adjustment>,
  policy: Policy,
  range: TimeRange,
): ConflictSegment[] {
  validateRange(range);
  const view = applyAdjustments(snapshot, adjustments);
  return runPrecheck(snapshot, view, policy, range);
}

function runPrecheck(
  snapshot: Snapshot,
  view: CandidateView,
  policy: Policy,
  range: TimeRange,
): ConflictSegment[] {
  // 角色 / 资源编号
  const roleIdx = new Map<RoleId, number>();
  const resourceIdx = new Map<ResourceId, number>();
  const idxOf = <T>(map: Map<T, number>, id: T): number => {
    let idx = map.get(id);
    if (idx === undefined) {
      idx = map.size;
      map.set(id, idx);
    }
    return idx;
  };

  // 规范化策略对：无序 -> 有序，去重
  const pairSeen = new Set<string>();
  const pairs: CanonicalPair[] = [];
  for (const p of policy.pairs) {
    if (p.roleA === p.roleB) throw new Error(`互斥角色对的两个角色相同: ${p.roleA}`);
    const [roleA, roleB] = p.roleA < p.roleB ? [p.roleA, p.roleB] : [p.roleB, p.roleA];
    const id = `${roleA}${roleB}`;
    if (pairSeen.has(id)) continue;
    pairSeen.add(id);
    pairs.push({ roleA, roleB, roleAIdx: idxOf(roleIdx, roleA), roleBIdx: idxOf(roleIdx, roleB) });
  }

  // 豁免索引：(员工, 资源, 角色对) -> 合并后的放行时段（已裁剪到查询范围）
  const exemptionMap = new Map<string, Span[]>();
  for (const ex of snapshot.data.exemptions) {
    const span = clipSpan(ex.start, ex.end, range);
    if (!span) continue;
    const [roleA, roleB] = ex.roleA < ex.roleB ? [ex.roleA, ex.roleB] : [ex.roleB, ex.roleA];
    const key = `${ex.employeeId}${ex.resourceId}${roleA}${roleB}`;
    const list = exemptionMap.get(key);
    if (list) list.push(span);
    else exemptionMap.set(key, [span]);
  }
  for (const [key, spans] of exemptionMap) {
    exemptionMap.set(key, mergeSpans(spans));
  }

  // 组织树：子节点列表 + 每个节点下的员工
  const children = new Map<OrgNodeId, OrgNodeId[]>();
  const roots: OrgNodeId[] = [];
  for (const node of snapshot.data.orgNodes) {
    if (node.parentId === null) roots.push(node.id);
    else {
      const list = children.get(node.parentId);
      if (list) list.push(node.id);
      else children.set(node.parentId, [node.id]);
    }
  }
  const employeesByNode = new Map<OrgNodeId, EmployeeId[]>();
  for (const emp of snapshot.employees) {
    const list = employeesByNode.get(emp.orgNodeId);
    if (list) list.push(emp.id);
    else employeesByNode.set(emp.orgNodeId, [emp.id]);
  }

  // 每个节点的组织授权（裁剪后按 key 分组）
  const nodeGrantSpans = new Map<OrgNodeId, Map<number, Span[]>>();
  const spansByKey = (grants: Iterable<import('./types').Grant>): Map<number, Span[]> => {
    const out = new Map<number, Span[]>();
    for (const g of grants) {
      const span = clipSpan(g.start, g.end, range);
      if (!span) continue;
      const key = keyOf(idxOf(resourceIdx, g.resourceId), idxOf(roleIdx, g.roleId));
      const list = out.get(key);
      if (list) list.push(span);
      else out.set(key, [span]);
    }
    return out;
  };

  const results: ConflictSegment[] = [];

  // DFS：cur 保存当前路径上 (资源,角色) 的有效时段，进入/离开节点时增量更新并回滚
  const cur = new Map<number, Span[]>();
  const undo: Array<[number, Span[] | undefined]> = [];

  const processEmployee = (employeeId: EmployeeId): void => {
    // 个人授权覆盖层
    let overrides: Map<number, Span[]> | null = null;
    const personal = view.personalGrants(employeeId);
    if (personal.length > 0) {
      const personalSpans = spansByKey(personal);
      overrides = new Map();
      for (const [key, spans] of personalSpans) {
        const inherited = cur.get(key);
        overrides.set(key, inherited ? mergeSpans([...inherited, ...spans]) : mergeSpans(spans));
      }
    }
    const eff = (key: number): Span[] | undefined => overrides?.get(key) ?? cur.get(key);

    for (const [resourceId, resIdx] of resourceIdx) {
      for (const pair of pairs) {
        const spansA = eff(keyOf(resIdx, pair.roleAIdx));
        if (!spansA) continue;
        const spansB = eff(keyOf(resIdx, pair.roleBIdx));
        if (!spansB) continue;
        let conflicts = intersectSpans(spansA, spansB);
        if (conflicts.length === 0) continue;
        const exKey = `${employeeId}${resourceId}${pair.roleA}${pair.roleB}`;
        const exempted = exemptionMap.get(exKey);
        if (exempted) conflicts = subtractSpans(conflicts, exempted);
        for (const seg of conflicts) {
          results.push({
            employeeId,
            resourceId,
            roleA: pair.roleA,
            roleB: pair.roleB,
            start: seg.start,
            end: seg.end,
          });
        }
      }
    }
  };

  const visit = (nodeId: OrgNodeId): void => {
    const undoMark = undo.length;
    const own = nodeGrantSpans.get(nodeId);
    if (own) {
      for (const [key, spans] of own) {
        const prev = cur.get(key);
        undo.push([key, prev]);
        cur.set(key, prev ? mergeSpans([...prev, ...spans]) : mergeSpans(spans));
      }
    }
    const emps = employeesByNode.get(nodeId);
    if (emps) for (const empId of emps) processEmployee(empId);
    const kids = children.get(nodeId);
    if (kids) for (const kid of kids) visit(kid);
    while (undo.length > undoMark) {
      const [key, prev] = undo.pop()!;
      if (prev === undefined) cur.delete(key);
      else cur.set(key, prev);
    }
  };

  for (const nodeId of snapshot.orgNodeIds) {
    const spans = spansByKey(view.orgGrants(nodeId));
    if (spans.size > 0) nodeGrantSpans.set(nodeId, spans);
  }
  for (const root of roots) visit(root);

  results.sort(
    (a, b) =>
      cmp(a.employeeId, b.employeeId) ||
      cmp(a.resourceId, b.resourceId) ||
      cmp(a.roleA, b.roleA) ||
      cmp(a.roleB, b.roleB) ||
      a.start - b.start ||
      a.end - b.end,
  );
  return results;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
