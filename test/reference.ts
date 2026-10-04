import type { Day, FlowId, LeadId } from "../src/index.js";

interface RawLead {
  flowId: FlowId;
  day: Day;
}

/**
 * 独立的全量重算参考模型：保存原始事实，每次从头计算。
 * 只用于测试对拍，不考虑性能。
 */
export class ReferenceModel {
  private readonly leads = new Map<LeadId, RawLead>();
  private readonly convertedIds = new Set<LeadId>();
  private readonly parent = new Map<LeadId, LeadId>();
  private readonly size = new Map<LeadId, number>();

  add(id: LeadId, flowId: FlowId, day: Day): void {
    this.leads.set(id, { flowId, day });
    this.parent.set(id, id);
    this.size.set(id, 1);
  }

  convert(id: LeadId): void {
    this.convertedIds.add(id);
  }

  merge(a: LeadId, b: LeadId): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    const sa = this.size.get(ra)!;
    const sb = this.size.get(rb)!;
    const [big, small] = sa >= sb ? [ra, rb] : [rb, ra];
    this.parent.set(small, big);
    this.size.set(big, sa + sb);
  }

  /** 全量重算：flowId -> (day -> {captured, converted})。 */
  recompute(): Map<FlowId, Map<Day, { captured: number; converted: number }>> {
    const groups = new Map<LeadId, LeadId[]>();
    for (const id of this.leads.keys()) {
      const root = this.find(id);
      let members = groups.get(root);
      if (!members) groups.set(root, (members = []));
      members.push(id);
    }
    const result = new Map<FlowId, Map<Day, { captured: number; converted: number }>>();
    for (const members of groups.values()) {
      let converted = false;
      const earliest = new Map<FlowId, Day>();
      for (const id of members) {
        if (this.convertedIds.has(id)) converted = true;
        const { flowId, day } = this.leads.get(id)!;
        const prev = earliest.get(flowId);
        if (prev === undefined || day < prev) earliest.set(flowId, day);
      }
      for (const [flowId, day] of earliest) {
        let byDay = result.get(flowId);
        if (!byDay) result.set(flowId, (byDay = new Map()));
        const counts = byDay.get(day) ?? { captured: 0, converted: 0 };
        counts.captured += 1;
        if (converted) counts.converted += 1;
        byDay.set(day, counts);
      }
    }
    return result;
  }

  flowIds(): FlowId[] {
    return [...new Set([...this.leads.values()].map((l) => l.flowId))];
  }

  private find(id: LeadId): LeadId {
    let root = id;
    while (this.parent.get(root) !== root) root = this.parent.get(root)!;
    // 路径压缩。
    let cur = id;
    while (this.parent.get(cur) !== root) {
      const next = this.parent.get(cur)!;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }
}

/** 确定性 PRNG（mulberry32）。 */
export function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
