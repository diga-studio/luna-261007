import { clampInterval, intersectIntervals, mergeIntervals, subtractIntervals } from './intervals.js';
import { Scenario } from './scenario.js';
import { exemptionLookupKey, Snapshot } from './snapshot.js';
import type { ConflictSegment, Interval, Millis, PrecheckOptions, PrecheckResult } from './types.js';

/** 查询范围上限：10 年（按 3660 天宽限计算，覆盖闰年） */
export const MAX_RANGE_MS = 3660 * 24 * 60 * 60 * 1000;

function validateRange(start: Millis, end: Millis): void {
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    throw new Error('range start/end must be integer milliseconds');
  }
  if (!(start < end)) throw new Error('range start must be before end');
  if (end - start > MAX_RANGE_MS) throw new Error('range exceeds 10 years');
}

interface Frame {
  readonly nodeId: string;
  childIndex: number;
  /** 进入该节点时向各角色追加的区间数量，退出时据此回退 */
  readonly added: [string, number][];
}

/** 预检：报告查询范围内所有未被豁免覆盖的冲突，按员工/资源/角色对输出最大连续冲突时段 */
export function precheck(snapshot: Snapshot, options: PrecheckOptions): PrecheckResult {
  const { start, end } = options.range;
  validateRange(start, end);

  const scenario = new Scenario(snapshot, options.adjustment);
  const conflicts: ConflictSegment[] = [];

  const roots: string[] = [];
  for (const node of snapshot.orgNodes) {
    if (node.parentId === null) roots.push(node.id);
  }

  for (const resourceId of scenario.resourceIds()) {
    const index = scenario.grantsForResource(resourceId)!;

    // 祖先组织授权区间栈：roleId -> 追加中的区间列表（DFS 进出节点时压入/回退）
    const inherited = new Map<string, Interval[]>();
    const stack: Frame[] = [];

    const enterNode = (nodeId: string): Frame => {
      const added: [string, number][] = [];
      const orgGrants = index.byOrgNode.get(nodeId);
      if (orgGrants) {
        for (const g of orgGrants) {
          const iv = clampInterval(
            { start: g.range.start, end: g.range.end ?? Infinity },
            start,
            end,
          );
          if (!iv) continue;
          let list = inherited.get(g.roleId);
          if (!list) {
            list = [];
            inherited.set(g.roleId, list);
          }
          list.push(iv);
          const last = added[added.length - 1];
          if (last && last[0] === g.roleId) last[1]++;
          else added.push([g.roleId, 1]);
        }
      }
      return { nodeId, childIndex: 0, added };
    };

    const exitNode = (frame: Frame): void => {
      for (const [roleId, count] of frame.added) {
        const list = inherited.get(roleId)!;
        list.length -= count;
        if (list.length === 0) inherited.delete(roleId);
      }
    };

    const processEmployees = (nodeId: string): void => {
      const employees = snapshot.employeesByOrgNode.get(nodeId);
      if (!employees) return;
      for (const emp of employees) {
        const personalByRole = new Map<string, Interval[]>();
        const personal = index.byEmployee.get(emp.id);
        if (personal) {
          for (const g of personal) {
            const iv = clampInterval(
              { start: g.range.start, end: g.range.end ?? Infinity },
              start,
              end,
            );
            if (!iv) continue;
            const list = personalByRole.get(g.roleId);
            if (list) list.push(iv);
            else personalByRole.set(g.roleId, [iv]);
          }
        }
        if (inherited.size === 0 && personalByRole.size === 0) continue;

        for (const pair of snapshot.mutexPairs) {
          const inhA = inherited.get(pair.roleA);
          const inhB = inherited.get(pair.roleB);
          const perA = personalByRole.get(pair.roleA);
          const perB = personalByRole.get(pair.roleB);
          if ((!inhA && !perA) || (!inhB && !perB)) continue;

          const unionA = mergeIntervals(perA ? (inhA ? inhA.concat(perA) : perA) : inhA!);
          const unionB = mergeIntervals(perB ? (inhB ? inhB.concat(perB) : perB) : inhB!);
          let segs = intersectIntervals(unionA, unionB);
          if (segs.length === 0) continue;

          const exKey = exemptionLookupKey(emp.id, resourceId, pair.roleA, pair.roleB);
          const exemptions = snapshot.exemptionsByKey.get(exKey);
          if (exemptions) segs = subtractIntervals(segs, exemptions);
          if (segs.length === 0) continue;

          for (const seg of segs) {
            conflicts.push({
              employeeId: emp.id,
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

    for (const rootId of roots) {
      stack.push(enterNode(rootId));
      while (stack.length > 0) {
        const top = stack[stack.length - 1]!;
        if (top.childIndex === 0) processEmployees(top.nodeId);
        const children = snapshot.childrenOf.get(top.nodeId);
        if (children && top.childIndex < children.length) {
          const child = children[top.childIndex]!;
          top.childIndex++;
          stack.push(enterNode(child.id));
        } else {
          exitNode(top);
          stack.pop();
        }
      }
    }
  }

  conflicts.sort(
    (x, y) =>
      (x.employeeId < y.employeeId ? -1 : x.employeeId > y.employeeId ? 1 : 0) ||
      (x.resourceId < y.resourceId ? -1 : x.resourceId > y.resourceId ? 1 : 0) ||
      (x.roleA < y.roleA ? -1 : x.roleA > y.roleA ? 1 : 0) ||
      (x.roleB < y.roleB ? -1 : x.roleB > y.roleB ? 1 : 0) ||
      (x.start - y.start),
  );
  return { conflicts };
}
