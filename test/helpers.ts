import { deepEqual } from "node:assert/strict";
import { FunnelStats } from "../src/index";
import type { ReportEntry } from "../src/index";

export type Op =
  | { type: "add"; id: string; flowId: string; day: number }
  | { type: "convert"; id: string }
  | { type: "merge"; a: string; b: string };

/** 可复现的伪随机数发生器。 */
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(rand: () => number, arr: T[]): T {
  return arr[Math.floor(rand() * arr.length)] as T;
}

export function applyOps(stats: FunnelStats, ops: Op[]): void {
  for (const op of ops) {
    if (op.type === "add") stats.add(op.id, op.flowId, op.day);
    else if (op.type === "convert") stats.convert(op.id);
    else stats.merge(op.a, op.b);
  }
}

/** 独立参考模型：基于全部原始记录与最终分组全量重算。 */
export function referenceReport(
  ops: Op[],
  flowIds: string[],
  fromDay: number,
  toDay: number
): Map<string, ReportEntry[]> {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root) as string;
    let cur = x;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur) as string;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const info = new Map<string, { flowId: string; day: number }>();
  const convertedIds = new Set<string>();
  for (const op of ops) {
    if (op.type === "add") {
      parent.set(op.id, op.id);
      info.set(op.id, { flowId: op.flowId, day: op.day });
    } else if (op.type === "convert") {
      convertedIds.add(op.id);
    } else {
      const ra = find(op.a);
      const rb = find(op.b);
      if (ra !== rb) parent.set(ra, rb);
    }
  }
  const groups = new Map<string, { converted: boolean; earliest: Map<string, number> }>();
  for (const [id, rec] of info) {
    const root = find(id);
    let g = groups.get(root);
    if (g === undefined) {
      g = { converted: false, earliest: new Map() };
      groups.set(root, g);
    }
    if (convertedIds.has(id)) g.converted = true;
    const cur = g.earliest.get(rec.flowId);
    if (cur === undefined || rec.day < cur) g.earliest.set(rec.flowId, rec.day);
  }
  const captured = new Map<string, Map<number, number>>();
  const converted = new Map<string, Map<number, number>>();
  const bump = (table: Map<string, Map<number, number>>, f: string, d: number) => {
    let byDay = table.get(f);
    if (byDay === undefined) {
      byDay = new Map();
      table.set(f, byDay);
    }
    byDay.set(d, (byDay.get(d) ?? 0) + 1);
  };
  for (const g of groups.values()) {
    for (const [f, d] of g.earliest) {
      bump(captured, f, d);
      if (g.converted) bump(converted, f, d);
    }
  }
  const out = new Map<string, ReportEntry[]>();
  for (const f of flowIds) {
    const entries: ReportEntry[] = [];
    for (let d = fromDay; d <= toDay; d++) {
      entries.push({
        day: d,
        captured: captured.get(f)?.get(d) ?? 0,
        converted: converted.get(f)?.get(d) ?? 0,
      });
    }
    out.set(f, entries);
  }
  return out;
}

export function assertReportsMatch(
  stats: FunnelStats,
  ops: Op[],
  flowIds: string[],
  fromDay: number,
  toDay: number,
  label: string
): void {
  const expected = referenceReport(ops, flowIds, fromDay, toDay);
  for (const f of flowIds) {
    deepEqual(stats.report(f, fromDay, toDay), expected.get(f), `${label} flowId=${f}`);
  }
}
