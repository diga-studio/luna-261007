import type {
  Adjustment,
  Employee,
  EmployeeId,
  Grant,
  OrgNodeId,
  ResourceId,
  RoleId,
  SnapshotData,
  TimeMs,
} from './types';

function assertIntegerTime(value: TimeMs, what: string): void {
  if (!Number.isInteger(value)) {
    throw new Error(`${what} 必须是整数毫秒，收到: ${value}`);
  }
}

function assertGrantTimes(grant: Grant): void {
  assertIntegerTime(grant.start, `授权 ${grant.id} 的 start`);
  if (grant.end !== undefined) {
    assertIntegerTime(grant.end, `授权 ${grant.id} 的 end`);
    if (grant.end <= grant.start) {
      throw new Error(`授权 ${grant.id} 的 end 必须大于 start`);
    }
  }
}

/** 不可变快照。预检与角色查看均不修改它。 */
export interface Snapshot {
  readonly data: SnapshotData;
  readonly employees: ReadonlyArray<Employee>;
  readonly employeeIds: ReadonlyArray<EmployeeId>;
  readonly orgNodeIds: ReadonlySet<OrgNodeId>;
  /** 员工 -> 所在节点及全部祖先（自近及远，含自身节点）。 */
  readonly ancestorChain: ReadonlyMap<EmployeeId, ReadonlyArray<OrgNodeId>>;
  /** 员工 -> 个人授权（快照内）。 */
  readonly personalGrants: ReadonlyMap<EmployeeId, ReadonlyArray<Grant>>;
  /** 组织节点 -> 组织授权（快照内）。 */
  readonly orgGrants: ReadonlyMap<OrgNodeId, ReadonlyArray<Grant>>;
  readonly grantById: ReadonlyMap<string, Grant>;
}

export function createSnapshot(data: SnapshotData): Snapshot {
  const orgParent = new Map<OrgNodeId, OrgNodeId | null>();
  for (const node of data.orgNodes) {
    if (orgParent.has(node.id)) throw new Error(`组织节点重复: ${node.id}`);
    orgParent.set(node.id, node.parentId);
  }
  for (const node of data.orgNodes) {
    if (node.parentId !== null && !orgParent.has(node.parentId)) {
      throw new Error(`组织节点 ${node.id} 的父节点不存在: ${node.parentId}`);
    }
  }

  const employeeOrg = new Map<EmployeeId, OrgNodeId>();
  for (const emp of data.employees) {
    if (employeeOrg.has(emp.id)) throw new Error(`员工重复: ${emp.id}`);
    if (!orgParent.has(emp.orgNodeId)) {
      throw new Error(`员工 ${emp.id} 所属组织节点不存在: ${emp.orgNodeId}`);
    }
    employeeOrg.set(emp.id, emp.orgNodeId);
  }

  // 祖先链：带环检测，深度不限。
  const chainCache = new Map<OrgNodeId, ReadonlyArray<OrgNodeId>>();
  const chainOf = (nodeId: OrgNodeId): ReadonlyArray<OrgNodeId> => {
    const cached = chainCache.get(nodeId);
    if (cached) return cached;
    const chain: OrgNodeId[] = [];
    const seen = new Set<OrgNodeId>();
    let cur: OrgNodeId | null = nodeId;
    while (cur !== null) {
      if (seen.has(cur)) throw new Error(`组织层级存在环，涉及节点: ${cur}`);
      seen.add(cur);
      chain.push(cur);
      cur = orgParent.get(cur) ?? null;
    }
    for (const id of chain) {
      if (!chainCache.has(id)) {
        const idx = chain.indexOf(id);
        chainCache.set(id, chain.slice(idx));
      }
    }
    return chainCache.get(nodeId)!;
  };

  const ancestorChain = new Map<EmployeeId, ReadonlyArray<OrgNodeId>>();
  for (const emp of data.employees) {
    ancestorChain.set(emp.id, chainOf(emp.orgNodeId));
  }

  const personalGrants = new Map<EmployeeId, Grant[]>();
  const orgGrants = new Map<OrgNodeId, Grant[]>();
  const grantById = new Map<string, Grant>();
  for (const grant of data.grants) {
    if (grantById.has(grant.id)) throw new Error(`授权标识重复: ${grant.id}`);
    assertGrantTimes(grant);
    grantById.set(grant.id, grant);
    if (grant.subject.kind === 'employee') {
      if (!employeeOrg.has(grant.subject.employeeId)) {
        throw new Error(`授权 ${grant.id} 指向不存在的员工: ${grant.subject.employeeId}`);
      }
      const list = personalGrants.get(grant.subject.employeeId);
      if (list) list.push(grant);
      else personalGrants.set(grant.subject.employeeId, [grant]);
    } else {
      if (!orgParent.has(grant.subject.orgNodeId)) {
        throw new Error(`授权 ${grant.id} 指向不存在的组织节点: ${grant.subject.orgNodeId}`);
      }
      const list = orgGrants.get(grant.subject.orgNodeId);
      if (list) list.push(grant);
      else orgGrants.set(grant.subject.orgNodeId, [grant]);
    }
  }

  for (const ex of data.exemptions) {
    if (!employeeOrg.has(ex.employeeId)) {
      throw new Error(`豁免指向不存在的员工: ${ex.employeeId}`);
    }
    assertIntegerTime(ex.start, '豁免的 start');
    if (ex.end !== undefined) {
      assertIntegerTime(ex.end, '豁免的 end');
      if (ex.end <= ex.start) throw new Error('豁免的 end 必须大于 start');
    }
  }

  return {
    data,
    employees: data.employees.slice(),
    employeeIds: data.employees.map((e) => e.id),
    orgNodeIds: new Set(orgParent.keys()),
    ancestorChain,
    personalGrants,
    orgGrants,
    grantById,
  };
}

/** 候选视图：快照 + 整组调整后的状态。原快照不被修改。 */
export interface CandidateView {
  readonly snapshot: Snapshot;
  /** 员工个人授权（调整后）。 */
  personalGrants(employeeId: EmployeeId): ReadonlyArray<Grant>;
  /** 组织节点授权（调整后）。 */
  orgGrants(orgNodeId: OrgNodeId): ReadonlyArray<Grant>;
  /** 某员工在某资源、某时刻实际拥有的角色（升序、去重）。 */
  rolesAt(employeeId: EmployeeId, resourceId: ResourceId, at: TimeMs): RoleId[];
}

export function applyAdjustments(
  snapshot: Snapshot,
  adjustments: ReadonlyArray<Adjustment>,
): CandidateView {
  const revoked = new Set<string>();
  const addedPersonal = new Map<EmployeeId, Grant[]>();
  const addedOrg = new Map<OrgNodeId, Grant[]>();
  const addedById = new Map<string, Grant>();

  for (const adj of adjustments) {
    if (adj.kind === 'add') {
      const grant = adj.grant;
      if (snapshot.grantById.has(grant.id) || addedById.has(grant.id)) {
        throw new Error(`新增授权的标识已存在: ${grant.id}`);
      }
      assertGrantTimes(grant);
      addedById.set(grant.id, grant);
      if (grant.subject.kind === 'employee') {
        if (!snapshot.ancestorChain.has(grant.subject.employeeId)) {
          throw new Error(`授权 ${grant.id} 指向不存在的员工: ${grant.subject.employeeId}`);
        }
        const list = addedPersonal.get(grant.subject.employeeId);
        if (list) list.push(grant);
        else addedPersonal.set(grant.subject.employeeId, [grant]);
      } else {
        if (!snapshot.orgNodeIds.has(grant.subject.orgNodeId)) {
          throw new Error(`授权 ${grant.id} 指向不存在的组织节点: ${grant.subject.orgNodeId}`);
        }
        const list = addedOrg.get(grant.subject.orgNodeId);
        if (list) list.push(grant);
        else addedOrg.set(grant.subject.orgNodeId, [grant]);
      }
    } else {
      if (!snapshot.grantById.has(adj.grantId) && !addedById.has(adj.grantId)) {
        throw new Error(`撤回的授权不存在: ${adj.grantId}`);
      }
      revoked.add(adj.grantId);
    }
  }

  const mergeLists = (
    base: ReadonlyArray<Grant> | undefined,
    added: Grant[] | undefined,
  ): ReadonlyArray<Grant> => {
    const out: Grant[] = [];
    if (base) for (const g of base) if (!revoked.has(g.id)) out.push(g);
    if (added) for (const g of added) if (!revoked.has(g.id)) out.push(g);
    return out;
  };

  const personalCache = new Map<EmployeeId, ReadonlyArray<Grant>>();
  const orgCache = new Map<OrgNodeId, ReadonlyArray<Grant>>();

  const view: CandidateView = {
    snapshot,
    personalGrants(employeeId) {
      let cached = personalCache.get(employeeId);
      if (!cached) {
        cached = mergeLists(snapshot.personalGrants.get(employeeId), addedPersonal.get(employeeId));
        personalCache.set(employeeId, cached);
      }
      return cached;
    },
    orgGrants(orgNodeId) {
      let cached = orgCache.get(orgNodeId);
      if (!cached) {
        cached = mergeLists(snapshot.orgGrants.get(orgNodeId), addedOrg.get(orgNodeId));
        orgCache.set(orgNodeId, cached);
      }
      return cached;
    },
    rolesAt(employeeId, resourceId, at) {
      const chain = snapshot.ancestorChain.get(employeeId);
      if (!chain) throw new Error(`员工不存在: ${employeeId}`);
      const roles = new Set<RoleId>();
      const consider = (grants: ReadonlyArray<Grant>): void => {
        for (const g of grants) {
          if (g.resourceId !== resourceId) continue;
          if (g.start > at) continue;
          if (g.end !== undefined && at >= g.end) continue;
          roles.add(g.roleId);
        }
      };
      consider(view.personalGrants(employeeId));
      for (const nodeId of chain) consider(view.orgGrants(nodeId));
      return Array.from(roles).sort();
    },
  };
  return view;
}
