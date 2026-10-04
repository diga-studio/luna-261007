import type { Employee, Exemption, Grant, Interval, OrgNode, Policy, SnapshotData } from './types.js';

/** 互斥角色对的规范化键（与角色书写顺序无关） */
export function pairKey(roleA: string, roleB: string): string {
  return roleA < roleB ? `${roleA}${roleB}` : `${roleB}${roleA}`;
}

function exemptionKey(employeeId: string, resourceId: string, roleA: string, roleB: string): string {
  return `${employeeId}${resourceId}${pairKey(roleA, roleB)}`;
}

export function exemptionLookupKey(employeeId: string, resourceId: string, roleA: string, roleB: string): string {
  return exemptionKey(employeeId, resourceId, roleA, roleB);
}

/**
 * 不可变快照：构造时建立索引，之后任何预检/调整都只读取、不修改。
 * 构造会浅拷贝传入的数组，避免调用方后续修改影响快照。
 */
export class Snapshot {
  readonly employees: readonly Employee[];
  readonly orgNodes: readonly OrgNode[];
  readonly grants: readonly Grant[];
  readonly policy: Policy;
  readonly exemptions: readonly Exemption[];

  readonly employeeById: ReadonlyMap<string, Employee>;
  readonly orgNodeById: ReadonlyMap<string, OrgNode>;
  /** orgNodeId -> 直接子节点 */
  readonly childrenOf: ReadonlyMap<string, readonly OrgNode[]>;
  /** orgNodeId -> 该节点（含后代未展开）直属员工 */
  readonly employeesByOrgNode: ReadonlyMap<string, readonly Employee[]>;
  /** 豁免索引：exemptionKey -> 时段列表（未合并，end 为 Infinity 表示无限期） */
  readonly exemptionsByKey: ReadonlyMap<string, readonly Interval[]>;
  /** 规范化后的互斥对（roleA < roleB） */
  readonly mutexPairs: readonly { readonly roleA: string; readonly roleB: string; readonly key: string }[];

  constructor(data: SnapshotData) {
    this.employees = data.employees.slice();
    this.orgNodes = data.orgNodes.slice();
    this.grants = data.grants.slice();
    this.exemptions = data.exemptions.slice();
    this.policy = { mutexPairs: data.policy.mutexPairs.slice() };

    const employeeById = new Map<string, Employee>();
    const employeesByOrgNode = new Map<string, Employee[]>();
    for (const emp of this.employees) {
      if (employeeById.has(emp.id)) throw new Error(`duplicate employee id: ${emp.id}`);
      employeeById.set(emp.id, emp);
      const list = employeesByOrgNode.get(emp.orgNodeId);
      if (list) list.push(emp);
      else employeesByOrgNode.set(emp.orgNodeId, [emp]);
    }
    this.employeeById = employeeById;
    this.employeesByOrgNode = employeesByOrgNode;

    const orgNodeById = new Map<string, OrgNode>();
    const childrenOf = new Map<string, OrgNode[]>();
    for (const node of this.orgNodes) {
      if (orgNodeById.has(node.id)) throw new Error(`duplicate org node id: ${node.id}`);
      orgNodeById.set(node.id, node);
    }
    for (const node of this.orgNodes) {
      if (node.parentId === null) continue;
      if (!orgNodeById.has(node.parentId)) throw new Error(`unknown parent org node: ${node.parentId}`);
      const list = childrenOf.get(node.parentId);
      if (list) list.push(node);
      else childrenOf.set(node.parentId, [node]);
    }
    for (const emp of this.employees) {
      if (!orgNodeById.has(emp.orgNodeId)) throw new Error(`unknown org node for employee ${emp.id}: ${emp.orgNodeId}`);
    }
    this.orgNodeById = orgNodeById;
    this.childrenOf = childrenOf;

    for (const g of this.grants) {
      if (g.target.kind === 'employee') {
        if (!employeeById.has(g.target.employeeId)) throw new Error(`grant ${g.id} targets unknown employee: ${g.target.employeeId}`);
      } else if (!orgNodeById.has(g.target.orgNodeId)) {
        throw new Error(`grant ${g.id} targets unknown org node: ${g.target.orgNodeId}`);
      }
    }

    const exemptionsByKey = new Map<string, Interval[]>();
    for (const ex of this.exemptions) {
      const key = exemptionKey(ex.employeeId, ex.resourceId, ex.roleA, ex.roleB);
      const iv: Interval = { start: ex.range.start, end: ex.range.end ?? Infinity };
      const list = exemptionsByKey.get(key);
      if (list) list.push(iv);
      else exemptionsByKey.set(key, [iv]);
    }
    this.exemptionsByKey = exemptionsByKey;

    const seen = new Set<string>();
    const pairs: { roleA: string; roleB: string; key: string }[] = [];
    for (const p of this.policy.mutexPairs) {
      if (p.roleA === p.roleB) throw new Error(`mutex pair with identical roles: ${p.roleA}`);
      const key = pairKey(p.roleA, p.roleB);
      if (seen.has(key)) continue;
      seen.add(key);
      const [roleA, roleB] = p.roleA < p.roleB ? [p.roleA, p.roleB] : [p.roleB, p.roleA];
      pairs.push({ roleA: roleA!, roleB: roleB!, key });
    }
    this.mutexPairs = pairs;
  }
}
