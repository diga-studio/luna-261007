import type { Adjustment, Grant } from './types.js';
import type { Snapshot } from './snapshot.js';

export interface ResourceGrantIndex {
  /** employeeId -> 该资源上的个人授权 */
  readonly byEmployee: Map<string, Grant[]>;
  /** orgNodeId -> 该资源上挂在该节点的组织授权 */
  readonly byOrgNode: Map<string, Grant[]>;
}

/**
 * 候选方案视图：快照 + 调整（新增/撤回授权）。
 * 不修改原快照；生效授权与索引在构造时一次性建立。
 */
export class Scenario {
  readonly snapshot: Snapshot;
  readonly adjustment: Adjustment | undefined;

  private readonly grants: Grant[];
  private readonly byResource: Map<string, ResourceGrantIndex>;

  constructor(snapshot: Snapshot, adjustment: Adjustment | undefined) {
    this.snapshot = snapshot;
    this.adjustment = adjustment;

    const removed = new Set(adjustment?.removedGrantIds ?? []);
    const added = adjustment?.addedGrants ?? [];

    const knownIds = new Set<string>();
    for (const g of snapshot.grants) knownIds.add(g.id);
    for (const id of removed) {
      if (!knownIds.has(id)) throw new Error(`cannot remove unknown grant id: ${id}`);
    }
    for (const g of added) {
      if (knownIds.has(g.id)) throw new Error(`added grant id already exists: ${g.id}`);
      knownIds.add(g.id);
      if (g.target.kind === 'employee') {
        if (!snapshot.employeeById.has(g.target.employeeId)) throw new Error(`added grant ${g.id} targets unknown employee: ${g.target.employeeId}`);
      } else if (!snapshot.orgNodeById.has(g.target.orgNodeId)) {
        throw new Error(`added grant ${g.id} targets unknown org node: ${g.target.orgNodeId}`);
      }
    }

    const grants: Grant[] = [];
    for (const g of snapshot.grants) {
      if (!removed.has(g.id)) grants.push(g);
    }
    for (const g of added) grants.push(g);
    this.grants = grants;

    const byResource = new Map<string, ResourceGrantIndex>();
    for (const g of grants) {
      let idx = byResource.get(g.resourceId);
      if (!idx) {
        idx = { byEmployee: new Map(), byOrgNode: new Map() };
        byResource.set(g.resourceId, idx);
      }
      if (g.target.kind === 'employee') {
        const list = idx.byEmployee.get(g.target.employeeId);
        if (list) list.push(g);
        else idx.byEmployee.set(g.target.employeeId, [g]);
      } else {
        const list = idx.byOrgNode.get(g.target.orgNodeId);
        if (list) list.push(g);
        else idx.byOrgNode.set(g.target.orgNodeId, [g]);
      }
    }
    this.byResource = byResource;
  }

  /** 生效的授权列表（快照授权去掉被撤回的，加上新增的） */
  effectiveGrants(): readonly Grant[] {
    return this.grants;
  }

  /** 某资源上的授权索引（无授权时返回 undefined） */
  grantsForResource(resourceId: string): ResourceGrantIndex | undefined {
    return this.byResource.get(resourceId);
  }

  /** 全部出现过的资源 id */
  resourceIds(): Iterable<string> {
    return this.byResource.keys();
  }
}
