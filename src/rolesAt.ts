import { Scenario } from './scenario.js';
import type { Snapshot } from './snapshot.js';
import type { Adjustment, Grant, Millis } from './types.js';

function coversAt(grant: Grant, at: Millis): boolean {
  const end = grant.range.end ?? Infinity;
  return grant.range.start <= at && at < end;
}

/** 查看候选方案下指定员工在某资源、某时刻实际拥有的角色集合 */
export function rolesAt(
  snapshot: Snapshot,
  employeeId: string,
  resourceId: string,
  at: Millis,
  adjustment?: Adjustment | undefined,
): ReadonlySet<string> {
  const employee = snapshot.employeeById.get(employeeId);
  if (!employee) throw new Error(`unknown employee: ${employeeId}`);

  const scenario = new Scenario(snapshot, adjustment);
  const index = scenario.grantsForResource(resourceId);
  const roles = new Set<string>();
  if (!index) return roles;

  const personal = index.byEmployee.get(employeeId);
  if (personal) {
    for (const g of personal) {
      if (coversAt(g, at)) roles.add(g.roleId);
    }
  }

  let nodeId: string | null = employee.orgNodeId;
  while (nodeId !== null) {
    const orgGrants = index.byOrgNode.get(nodeId);
    if (orgGrants) {
      for (const g of orgGrants) {
        if (coversAt(g, at)) roles.add(g.roleId);
      }
    }
    nodeId = snapshot.orgNodeById.get(nodeId)?.parentId ?? null;
  }
  return roles;
}
