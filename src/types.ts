/** 时间戳：整数毫秒。时段均为 [start, end)，end 缺省表示无限期。 */
export type Millis = number;

export interface TimeRange {
  readonly start: Millis;
  readonly end?: Millis | undefined;
}

export interface Employee {
  readonly id: string;
  readonly orgNodeId: string;
}

export interface OrgNode {
  readonly id: string;
  /** 根节点的 parentId 为 null */
  readonly parentId: string | null;
}

export type GrantTarget =
  | { readonly kind: 'employee'; readonly employeeId: string }
  | { readonly kind: 'orgNode'; readonly orgNodeId: string };

export interface Grant {
  readonly id: string;
  readonly target: GrantTarget;
  readonly roleId: string;
  readonly resourceId: string;
  readonly range: TimeRange;
}

export interface MutexPair {
  readonly roleA: string;
  readonly roleB: string;
}

export interface Policy {
  readonly mutexPairs: readonly MutexPair[];
}

export interface Exemption {
  readonly id: string;
  readonly employeeId: string;
  readonly resourceId: string;
  readonly roleA: string;
  readonly roleB: string;
  readonly range: TimeRange;
}

export interface SnapshotData {
  readonly employees: readonly Employee[];
  readonly orgNodes: readonly OrgNode[];
  readonly grants: readonly Grant[];
  readonly policy: Policy;
  readonly exemptions: readonly Exemption[];
}

export interface Adjustment {
  readonly addedGrants?: readonly Grant[];
  readonly removedGrantIds?: readonly string[];
}

export interface ConflictSegment {
  readonly employeeId: string;
  readonly resourceId: string;
  readonly roleA: string;
  readonly roleB: string;
  readonly start: Millis;
  readonly end: Millis;
}

export interface PrecheckOptions {
  /** 查询范围 [start, end)，必须有限且跨度不超过 10 年 */
  readonly range: { readonly start: Millis; readonly end: Millis };
  readonly adjustment?: Adjustment | undefined;
}

export interface PrecheckResult {
  readonly conflicts: readonly ConflictSegment[];
}

/** 单个时段 [start, end)，end 用 Infinity 表示无限期（内部表示） */
export interface Interval {
  start: Millis;
  end: Millis;
}
