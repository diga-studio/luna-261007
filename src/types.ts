/** 时间戳：整数毫秒。所有时段为 [start, end)，start 包含、end 不包含。 */
export type TimeMs = number;

export type EmployeeId = string;
export type OrgNodeId = string;
export type RoleId = string;
export type ResourceId = string;
export type GrantId = string;

/** 组织节点，parentId 为 null 表示根节点。深度不限。 */
export interface OrgNode {
  id: OrgNodeId;
  parentId: OrgNodeId | null;
}

export interface Employee {
  id: EmployeeId;
  orgNodeId: OrgNodeId;
}

export type GrantSubject =
  | { kind: 'employee'; employeeId: EmployeeId }
  | { kind: 'org'; orgNodeId: OrgNodeId };

/** 授权。end 缺省表示长期（无结束时刻）。 */
export interface Grant {
  id: GrantId;
  subject: GrantSubject;
  roleId: RoleId;
  resourceId: ResourceId;
  start: TimeMs;
  end?: TimeMs;
}

/** 已批准豁免：精确绑定员工、资源、无序角色对与有效时段。 */
export interface Exemption {
  employeeId: EmployeeId;
  resourceId: ResourceId;
  roleA: RoleId;
  roleB: RoleId;
  start: TimeMs;
  end?: TimeMs;
}

/** 互斥策略：若干无序角色对。 */
export interface Policy {
  pairs: ReadonlyArray<{ roleA: RoleId; roleB: RoleId }>;
}

/** 调用方指定的有限查询范围，[start, end)。 */
export interface TimeRange {
  start: TimeMs;
  end: TimeMs;
}

export interface SnapshotData {
  employees: ReadonlyArray<Employee>;
  orgNodes: ReadonlyArray<OrgNode>;
  grants: ReadonlyArray<Grant>;
  exemptions: ReadonlyArray<Exemption>;
}

/** 调整：新增授权，或按标识撤回已有授权。 */
export type Adjustment =
  | { kind: 'add'; grant: Grant }
  | { kind: 'revoke'; grantId: GrantId };

/** 一段最大连续冲突时段。 */
export interface ConflictSegment {
  employeeId: EmployeeId;
  resourceId: ResourceId;
  roleA: RoleId;
  roleB: RoleId;
  start: TimeMs;
  end: TimeMs;
}
