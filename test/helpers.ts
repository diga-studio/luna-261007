import type {
  Adjustment,
  ConflictSegment,
  EmployeeId,
  Grant,
  OrgNodeId,
  Policy,
  SnapshotData,
  TimeRange,
} from '../src/types';

/**
 * 独立参考实现：直接按业务定义计算。
 * 收集所有授权/豁免的边界点，把查询范围切成基本区间；
 * 每个基本区间内授权集合不变，逐区间判定冲突与豁免，最后合并相邻冲突。
 * 刻意不复用 src 的任何区间工具，保证实现独立。
 */
export function referencePrecheck(
  data: SnapshotData,
  adjustments: ReadonlyArray<Adjustment>,
  policy: Policy,
  range: TimeRange,
): ConflictSegment[] {
  // 应用调整到普通数组
  const revoked = new Set<string>();
  const grants: Grant[] = [];
  for (const adj of adjustments) {
    if (adj.kind === 'add') grants.push(adj.grant);
    else revoked.add(adj.grantId);
  }
  for (const g of data.grants) if (!revoked.has(g.id)) grants.push(g);
  const finalGrants = grants.filter((g) => !revoked.has(g.id));

  // 员工 -> 祖先节点（含自身节点）
  const parentOf = new Map<OrgNodeId, OrgNodeId | null>();
  for (const n of data.orgNodes) parentOf.set(n.id, n.parentId);
  const ancestorsOf = (orgNodeId: OrgNodeId): OrgNodeId[] => {
    const chain: OrgNodeId[] = [];
    let cur: OrgNodeId | null = orgNodeId;
    while (cur !== null) {
      chain.push(cur);
      cur = parentOf.get(cur) ?? null;
    }
    return chain;
  };

  // 规范化策略对
  const pairSeen = new Set<string>();
  const pairs: Array<{ roleA: string; roleB: string }> = [];
  for (const p of policy.pairs) {
    const [a, b] = p.roleA < p.roleB ? [p.roleA, p.roleB] : [p.roleB, p.roleA];
    const id = `${a} ${b}`;
    if (!pairSeen.has(id)) {
      pairSeen.add(id);
      pairs.push({ roleA: a, roleB: b });
    }
  }

  const results: ConflictSegment[] = [];

  for (const emp of data.employees) {
    const ancestors = new Set(ancestorsOf(emp.orgNodeId));
    const relevant = finalGrants.filter((g) =>
      g.subject.kind === 'employee'
        ? g.subject.employeeId === emp.id
        : ancestors.has(g.subject.orgNodeId),
    );
    const resources = new Set<string>();
    for (const g of relevant) resources.add(g.resourceId);

    for (const resourceId of resources) {
      const resGrants = relevant.filter((g) => g.resourceId === resourceId);
      for (const pair of pairs) {
        // 该 (员工,资源,角色对) 的全部边界点
        const bounds = new Set<number>([range.start, range.end]);
        const pairGrants = resGrants.filter(
          (g) => g.roleId === pair.roleA || g.roleId === pair.roleB,
        );
        for (const g of pairGrants) {
          bounds.add(Math.max(g.start, range.start));
          bounds.add(Math.min(g.end === undefined ? range.end : g.end, range.end));
        }
        const exemptions = data.exemptions.filter(
          (ex) =>
            ex.employeeId === emp.id &&
            ex.resourceId === resourceId &&
            ((ex.roleA === pair.roleA && ex.roleB === pair.roleB) ||
              (ex.roleA === pair.roleB && ex.roleB === pair.roleA)),
        );
        for (const ex of exemptions) {
          bounds.add(Math.max(ex.start, range.start));
          bounds.add(Math.min(ex.end === undefined ? range.end : ex.end, range.end));
        }
        const sorted = Array.from(bounds)
          .filter((b) => b >= range.start && b <= range.end)
          .sort((a, b) => a - b);

        const active = (g: Grant, t: number): boolean =>
          g.start <= t && (g.end === undefined || t < g.end);

        let segStart: number | null = null;
        for (let i = 0; i < sorted.length - 1; i++) {
          const t0 = sorted[i]!;
          const t1 = sorted[i + 1]!;
          if (t0 >= t1) continue;
          const hasA = pairGrants.some((g) => g.roleId === pair.roleA && active(g, t0));
          const hasB = pairGrants.some((g) => g.roleId === pair.roleB && active(g, t0));
          const exempted = exemptions.some(
            (ex) => ex.start <= t0 && (ex.end === undefined || t0 < ex.end),
          );
          const inConflict = hasA && hasB && !exempted;
          if (inConflict && segStart === null) segStart = t0;
          if (!inConflict && segStart !== null) {
            results.push({
              employeeId: emp.id,
              resourceId,
              roleA: pair.roleA,
              roleB: pair.roleB,
              start: segStart,
              end: t0,
            });
            segStart = null;
          }
        }
        if (segStart !== null) {
          results.push({
            employeeId: emp.id,
            resourceId,
            roleA: pair.roleA,
            roleB: pair.roleB,
            start: segStart,
            end: range.end,
          });
        }
      }
    }
  }

  results.sort(
    (a, b) =>
      (a.employeeId < b.employeeId ? -1 : a.employeeId > b.employeeId ? 1 : 0) ||
      (a.resourceId < b.resourceId ? -1 : a.resourceId > b.resourceId ? 1 : 0) ||
      (a.roleA < b.roleA ? -1 : a.roleA > b.roleA ? 1 : 0) ||
      (a.roleB < b.roleB ? -1 : a.roleB > b.roleB ? 1 : 0) ||
      a.start - b.start ||
      a.end - b.end,
  );
  return results;
}

/** 参考实现：某员工在某资源、某时刻实际拥有的角色。 */
export function referenceRolesAt(
  data: SnapshotData,
  adjustments: ReadonlyArray<Adjustment>,
  employeeId: EmployeeId,
  resourceId: string,
  at: number,
): string[] {
  const revoked = new Set<string>();
  const added: Grant[] = [];
  for (const adj of adjustments) {
    if (adj.kind === 'add') added.push(adj.grant);
    else revoked.add(adj.grantId);
  }
  const grants = [...data.grants, ...added].filter((g) => !revoked.has(g.id));
  const parentOf = new Map<OrgNodeId, OrgNodeId | null>();
  for (const n of data.orgNodes) parentOf.set(n.id, n.parentId);
  const emp = data.employees.find((e) => e.id === employeeId);
  if (!emp) throw new Error(`员工不存在: ${employeeId}`);
  const ancestors = new Set<OrgNodeId>();
  let cur: OrgNodeId | null = emp.orgNodeId;
  while (cur !== null) {
    ancestors.add(cur);
    cur = parentOf.get(cur) ?? null;
  }
  const roles = new Set<string>();
  for (const g of grants) {
    if (g.resourceId !== resourceId) continue;
    if (g.start > at || (g.end !== undefined && at >= g.end)) continue;
    if (g.subject.kind === 'employee' && g.subject.employeeId !== employeeId) continue;
    if (g.subject.kind === 'org' && !ancestors.has(g.subject.orgNodeId)) continue;
    roles.add(g.roleId);
  }
  return Array.from(roles).sort();
}

/** 简单可复现的伪随机数生成器。 */
export function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}
