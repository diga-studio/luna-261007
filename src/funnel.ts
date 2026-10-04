import { FlowStats } from "./flow-stats.js";
import type { Day, FlowId, FunnelReport, LeadId } from "./types.js";

/**
 * 一个逻辑客户（归并组）挂在并查集根节点上的数据。
 * 不保存成员列表：成员身份只通过 parent 指针表达。
 */
interface Group {
  /** 并查集权重（取 1 与渠道数的较大者），保证小组合并进大组。 */
  weight: number;
  /** 组是否已转化（归并时取逻辑或，只能 false -> true）。 */
  converted: boolean;
  /** flowId -> 该组在此渠道上的最早 day。 */
  flows: Map<FlowId, Day>;
}

/**
 * 线索归并后的增量漏斗统计。
 *
 * 不变式：对每个组、每个它出现过的 flowId，全局计数中恰有一条
 * captured 落在 (flowId, 组内该渠道最早 day)；若组已转化，同位置
 * 还有一条 converted。所有操作返回前增量维护该不变式，report 只读。
 */
export class FunnelStats {
  private readonly parent = new Map<LeadId, LeadId>();
  private readonly groups = new Map<LeadId, Group>();
  private readonly stats = new Map<FlowId, FlowStats>();

  /** 新增一条未转化的原始线索。id 全局唯一。 */
  add(id: LeadId, flowId: FlowId, day: Day): void {
    if (this.parent.has(id)) {
      throw new Error(`duplicate lead id: ${String(id)}`);
    }
    this.parent.set(id, id);
    this.groups.set(id, { weight: 1, converted: false, flows: new Map([[flowId, day]]) });
    this.flowStats(flowId).addCaptured(day, 1);
  }

  /** 将 id 当前所属的整组标记为已转化；重复调用无额外影响。 */
  convert(id: LeadId): void {
    const group = this.groupOf(id);
    if (group.converted) return;
    group.converted = true;
    for (const [flowId, day] of group.flows) {
      this.flowStats(flowId).addConverted(day, 1);
    }
  }

  /**
   * 归并两个 id 所属的整组；同组归并无影响。
   * 已转化状态取逻辑或。只扫描渠道数较少一方的渠道表。
   */
  merge(a: LeadId, b: LeadId): void {
    let rootA = this.find(a);
    let rootB = this.find(b);
    if (rootA === rootB) return;

    let groupA = this.groups.get(rootA)!;
    let groupB = this.groups.get(rootB)!;
    if (groupA.weight < groupB.weight) {
      [rootA, rootB] = [rootB, rootA];
      [groupA, groupB] = [groupB, groupA];
    }
    // 目标：groupB 并入 groupA。

    // 1) 从全局计数中整体摘除 groupB 的贡献。
    for (const [flowId, day] of groupB.flows) {
      const stats = this.flowStats(flowId);
      stats.addCaptured(day, -1);
      if (groupB.converted) stats.addConverted(day, -1);
    }

    // 2) 若归并使 groupA 由未转化变为已转化，为 groupA 现有渠道补上 converted。
    const converted = groupA.converted || groupB.converted;
    if (converted && !groupA.converted) {
      for (const [flowId, day] of groupA.flows) {
        this.flowStats(flowId).addConverted(day, 1);
      }
    }
    groupA.converted = converted;

    // 3) 把 groupB 的渠道逐个并入 groupA，只动受影响的计数。
    for (const [flowId, dayB] of groupB.flows) {
      const stats = this.flowStats(flowId);
      const dayA = groupA.flows.get(flowId);
      if (dayA === undefined) {
        groupA.flows.set(flowId, dayB);
        stats.addCaptured(dayB, 1);
        if (groupA.converted) stats.addConverted(dayB, 1);
      } else if (dayB < dayA) {
        stats.addCaptured(dayA, -1);
        if (groupA.converted) stats.addConverted(dayA, -1);
        groupA.flows.set(flowId, dayB);
        stats.addCaptured(dayB, 1);
        if (groupA.converted) stats.addConverted(dayB, 1);
      }
      // dayB >= dayA：groupA 原有贡献已覆盖，无需改动。
    }

    groupA.weight += groupB.weight;
    this.parent.set(rootB, rootA);
    this.groups.delete(rootB);
  }

  /** 返回该渠道在闭区间 [fromDay, toDay] 内按日的 captured/converted。 */
  report(flowId: FlowId, fromDay: Day, toDay: Day): FunnelReport {
    const stats = this.stats.get(flowId);
    if (!stats) {
      return { flowId, fromDay, toDay, days: [], totalCaptured: 0, totalConverted: 0 };
    }
    return stats.query(flowId, fromDay, toDay);
  }

  private groupOf(id: LeadId): Group {
    return this.groups.get(this.find(id))!;
  }

  private find(id: LeadId): LeadId {
    const root = this.parent.get(id);
    if (root === undefined) {
      throw new Error(`unknown lead id: ${String(id)}`);
    }
    if (root === id) return id;
    const resolved = this.find(root);
    this.parent.set(id, resolved);
    return resolved;
  }

  private flowStats(flowId: FlowId): FlowStats {
    let stats = this.stats.get(flowId);
    if (!stats) {
      stats = new FlowStats();
      this.stats.set(flowId, stats);
    }
    return stats;
  }
}
