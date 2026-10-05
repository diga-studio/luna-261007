import { groupKey, type CveDatabase, type GroupIndex } from "./database";
import { parseVersion } from "./version";
import type { InstallRecord, MatchRelation } from "./types";

interface VersionBucket {
  version: number;
  recordIds: string[];
}

/**
 * 对一批安装记录进行匹配，返回全部命中关系。
 * 结果按 (recordId, cveId) 字典序排序，与输入顺序、重复调用无关。
 */
export function matchInventory(
  db: CveDatabase,
  records: InstallRecord[],
): MatchRelation[] {
  return Array.from(matchInventoryIter(db, records));
}

/**
 * 逐条产出命中关系的生成器版本，供调用方流式消费。
 * 产出顺序与 matchInventory 一致。
 */
export function* matchInventoryIter(
  db: CveDatabase,
  records: InstallRecord[],
): Generator<MatchRelation, void, undefined> {
  const byGroup = new Map<string, Map<number, string[]>>();
  for (const record of records) {
    const key = groupKey(record.vendor, record.product);
    let versions = byGroup.get(key);
    if (versions === undefined) {
      versions = new Map();
      byGroup.set(key, versions);
    }
    const code = parseVersion(record.version);
    const bucket = versions.get(code);
    if (bucket === undefined) {
      versions.set(code, [record.id]);
    } else {
      bucket.push(record.id);
    }
  }

  const relationRecords: string[] = [];
  const relationCves: string[] = [];

  for (const [key, versions] of byGroup) {
    const group = db.groups.get(key);
    if (group === undefined) {
      continue;
    }
    const buckets: VersionBucket[] = [];
    for (const [version, recordIds] of versions) {
      buckets.push({ version, recordIds });
    }
    buckets.sort((a, b) => a.version - b.version);
    collectGroupRelations(group, buckets, relationRecords, relationCves);
  }

  const order = Array.from({ length: relationRecords.length }, (_, i) => i);
  order.sort((a, b) => {
    const ra = relationRecords[a]!;
    const rb = relationRecords[b]!;
    if (ra !== rb) {
      return ra < rb ? -1 : 1;
    }
    const ca = relationCves[a]!;
    const cb = relationCves[b]!;
    return ca < cb ? -1 : ca > cb ? 1 : 0;
  });
  for (const i of order) {
    yield { recordId: relationRecords[i]!, cveId: relationCves[i]! };
  }
}

function collectGroupRelations(
  group: GroupIndex,
  buckets: VersionBucket[],
  outRecords: string[],
  outCves: string[],
): void {
  const { cveIds, eventPos, eventCve, eventDelta } = group;
  const counts = new Int32Array(cveIds.length);
  // 去重标记：同一查询点处每个 CVE 只保留一次，避免活跃列表中的陈旧项重复计数。
  const marks = new Uint32Array(cveIds.length);
  let stamp = 0;
  let active: number[] = [];
  let eventPtr = 0;

  for (const bucket of buckets) {
    const v = bucket.version;
    while (eventPtr < eventPos.length && eventPos[eventPtr]! <= v) {
      const cve = eventCve[eventPtr]!;
      const delta = eventDelta[eventPtr]!;
      const next = counts[cve]! + delta;
      counts[cve] = next;
      if (delta > 0 && next === 1) {
        active.push(cve);
      }
      eventPtr += 1;
    }
    if (active.length === 0) {
      continue;
    }
    // 就地压缩 active（丢弃计数为 0 与重复项），同时收集当前命中的 CVE 编号。
    stamp += 1;
    const hits: string[] = [];
    let kept = 0;
    for (const cve of active) {
      if (counts[cve]! > 0 && marks[cve] !== stamp) {
        marks[cve] = stamp;
        active[kept] = cve;
        kept += 1;
        hits.push(cveIds[cve]!);
      }
    }
    active.length = kept;
    if (hits.length === 0) {
      continue;
    }
    for (const recordId of bucket.recordIds) {
      for (const cveId of hits) {
        outRecords.push(recordId);
        outCves.push(cveId);
      }
    }
  }
}
