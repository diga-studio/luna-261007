import { readFileSync } from "node:fs";
import { parseVersion } from "./version.js";
import type { VersionRange, VulnerabilityDbFile } from "./types.js";

/** 半开区间事件：pos 处某 CVE 的命中计数加 delta（+1 进入，-1 离开）。 */
export interface RangeEvent {
  pos: number;
  cve: number;
  delta: number;
}

/** 单个 厂商+产品 分组的索引。 */
export interface GroupIndex {
  /** 按 (pos, cve, delta) 升序排序的事件流。 */
  events: RangeEvent[];
  /** 组内 CVE 局部编号 -> 全局 CVE 编号。 */
  cveIds: string[];
}

/** 已加载并建立索引的漏洞库，匹配期间不可变。 */
export interface CveDatabase {
  readonly cveCount: number;
  readonly itemCount: number;
  /** 内部索引：vendor 与 product 拼接的分组键 -> 分组索引。 */
  readonly groups: ReadonlyMap<string, GroupIndex>;
}

export function groupKey(vendor: string, product: string): string {
  return `${vendor} ${product}`;
}

/** 把版本区间规范化为半开区间 [lo, hi)；空区间返回 null。 */
function toHalfOpen(range: VersionRange): { lo: number; hi: number } | null {
  let lo = Number.NEGATIVE_INFINITY;
  let hi = Number.POSITIVE_INFINITY;
  if (range.lower !== undefined) {
    const v = parseVersion(range.lower.version);
    lo = range.lower.inclusive ? v : v + 1;
  }
  if (range.upper !== undefined) {
    const v = parseVersion(range.upper.version);
    hi = range.upper.inclusive ? v + 1 : v;
  }
  return lo < hi ? { lo, hi } : null;
}

/** 从主区间中减去若干排除区间，返回剩余的半开区间列表（升序、互不重叠）。 */
function subtractExclusions(
  main: { lo: number; hi: number },
  exclusions: VersionRange[],
): { lo: number; hi: number }[] {
  const cuts = exclusions
    .map(toHalfOpen)
    .filter((r): r is { lo: number; hi: number } => r !== null)
    .filter((r) => r.lo < main.hi && r.hi > main.lo)
    .sort((a, b) => a.lo - b.lo || a.hi - b.hi);
  const segments: { lo: number; hi: number }[] = [];
  let cursor = main.lo;
  for (const cut of cuts) {
    const cutLo = Math.max(cut.lo, main.lo);
    const cutHi = Math.min(cut.hi, main.hi);
    if (cursor < cutLo) {
      segments.push({ lo: cursor, hi: cutLo });
    }
    if (cutHi > cursor) {
      cursor = cutHi;
    }
  }
  if (cursor < main.hi) {
    segments.push({ lo: cursor, hi: main.hi });
  }
  return segments;
}

/** 从已解析的 JSON 对象加载漏洞库并建立内存索引。 */
export function loadDatabase(data: VulnerabilityDbFile): CveDatabase {
  const groups = new Map<string, { events: RangeEvent[]; cveMap: Map<string, number> }>();
  let itemCount = 0;
  const seenCveIds = new Set<string>();

  for (const cve of data.cves) {
    if (typeof cve.cveId !== "string" || cve.cveId.length === 0) {
      throw new Error("CVE entry missing cveId");
    }
    seenCveIds.add(cve.cveId);
    for (const item of cve.items) {
      itemCount += 1;
      const main = toHalfOpen(item.range);
      if (main === null) {
        continue;
      }
      const segments = subtractExclusions(main, item.exclusions ?? []);
      if (segments.length === 0) {
        continue;
      }
      const key = groupKey(item.vendor, item.product);
      let group = groups.get(key);
      if (group === undefined) {
        group = { events: [], cveMap: new Map() };
        groups.set(key, group);
      }
      let local = group.cveMap.get(cve.cveId);
      if (local === undefined) {
        local = group.cveMap.size;
        group.cveMap.set(cve.cveId, local);
      }
      for (const seg of segments) {
        group.events.push({ pos: seg.lo, cve: local, delta: 1 });
        group.events.push({ pos: seg.hi, cve: local, delta: -1 });
      }
    }
  }

  const index = new Map<string, GroupIndex>();
  for (const [key, group] of groups) {
    group.events.sort((a, b) => a.pos - b.pos || a.cve - b.cve || a.delta - b.delta);
    const cveIds: string[] = new Array<string>(group.cveMap.size);
    for (const [cveId, local] of group.cveMap) {
      cveIds[local] = cveId;
    }
    index.set(key, { events: group.events, cveIds });
  }

  return { cveCount: seenCveIds.size, itemCount, groups: index };
}

/** 从本地 JSON 文件加载漏洞库。 */
export function loadDatabaseFromFile(path: string): CveDatabase {
  const text = readFileSync(path, "utf8");
  return loadDatabase(JSON.parse(text) as VulnerabilityDbFile);
}
