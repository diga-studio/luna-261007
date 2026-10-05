import { readFileSync } from "node:fs";
import { normalizeRange, subtractExclusions } from "./ranges";
import type { VersionRange, VulnerabilityDatabaseFile } from "./types";

/**
 * 单个 (vendor, product) 分组的扫描线索引。
 * 事件按位置升序：位置 pos 处 eventDelta=+1 表示某 CVE 的一个命中区间开始，
 * -1 表示结束（结束位置为 hi+1，因此查询点 v 处先应用全部 pos<=v 的事件）。
 */
export interface GroupIndex {
  /** 本组出现过的 CVE 编号（去重）。 */
  readonly cveIds: readonly string[];
  readonly eventPos: Float64Array;
  readonly eventCve: Int32Array;
  readonly eventDelta: Int8Array;
}

/** 已加载并建立索引的漏洞库，加载后只读。 */
export interface CveDatabase {
  readonly cveCount: number;
  readonly itemCount: number;
  /** 内部结构，供匹配器使用。 */
  readonly groups: ReadonlyMap<string, GroupIndex>;
}

/** 分组键：长度前缀避免任何歧义。 */
export function groupKey(vendor: string, product: string): string {
  return `${vendor.length}:${vendor}${product}`;
}

interface PendingItem {
  cveId: string;
  range: VersionRange;
  exclusions: VersionRange[];
}

export function buildDatabase(data: VulnerabilityDatabaseFile): CveDatabase {
  if (!Array.isArray(data?.cves)) {
    throw new Error("invalid vulnerability database: missing cves array");
  }
  const pending = new Map<string, PendingItem[]>();
  let itemCount = 0;

  for (const cve of data.cves) {
    if (typeof cve?.id !== "string" || !Array.isArray(cve.items)) {
      throw new Error("invalid cve entry: missing id or items");
    }
    for (const item of cve.items) {
      if (typeof item?.vendor !== "string" || typeof item?.product !== "string") {
        throw new Error("invalid applicability item: missing vendor or product");
      }
      const key = groupKey(item.vendor, item.product);
      let list = pending.get(key);
      if (list === undefined) {
        list = [];
        pending.set(key, list);
      }
      list.push({
        cveId: cve.id,
        range: item.range ?? {},
        exclusions: item.exclusions ?? [],
      });
      itemCount += 1;
    }
  }

  const groups = new Map<string, GroupIndex>();
  for (const [key, items] of pending) {
    groups.set(key, buildGroup(items));
  }
  return { cveCount: data.cves.length, itemCount, groups };
}

function buildGroup(items: PendingItem[]): GroupIndex {
  const cveIds: string[] = [];
  const cveIndexById = new Map<string, number>();
  const positions: number[] = [];
  const cveRefs: number[] = [];
  const deltas: number[] = [];

  for (const item of items) {
    let cveIndex = cveIndexById.get(item.cveId);
    if (cveIndex === undefined) {
      cveIndex = cveIds.length;
      cveIds.push(item.cveId);
      cveIndexById.set(item.cveId, cveIndex);
    }
    const base = normalizeRange(item.range);
    if (base === null) {
      continue;
    }
    const exclusions = [];
    for (const ex of item.exclusions) {
      const interval = normalizeRange(ex);
      if (interval !== null) {
        exclusions.push(interval);
      }
    }
    for (const hit of subtractExclusions(base, exclusions)) {
      positions.push(hit.lo, hit.hi + 1);
      cveRefs.push(cveIndex, cveIndex);
      deltas.push(1, -1);
    }
  }

  const order = Array.from({ length: positions.length }, (_, i) => i);
  order.sort((a, b) => positions[a]! - positions[b]!);

  const eventPos = new Float64Array(positions.length);
  const eventCve = new Int32Array(positions.length);
  const eventDelta = new Int8Array(positions.length);
  for (let i = 0; i < order.length; i += 1) {
    const src = order[i]!;
    eventPos[i] = positions[src]!;
    eventCve[i] = cveRefs[src]!;
    eventDelta[i] = deltas[src]!;
  }
  return { cveIds, eventPos, eventCve, eventDelta };
}

export function loadDatabaseFile(path: string): CveDatabase {
  const text = readFileSync(path, "utf8");
  return buildDatabase(JSON.parse(text) as VulnerabilityDatabaseFile);
}
