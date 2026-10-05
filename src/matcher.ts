import { groupKey, type CveDatabase } from "./database.js";
import { parseVersion } from "./version.js";
import type { InstallationRecord, MatchRelation } from "./types.js";

/**
 * 对一批安装记录进行匹配，以生成器形式逐条产出命中关系。
 *
 * 输出顺序确定（分组键、版本、安装标识均排序后产出），
 * 与输入排列顺序及重复调用无关；同一安装记录对同一 CVE 只产出一次。
 */
export function* matchInstallations(
  db: CveDatabase,
  installations: Iterable<InstallationRecord>,
): Generator<MatchRelation, void, undefined> {
  // 按 厂商+产品 分组，组内按编码版本聚合安装标识。
  const byGroup = new Map<string, Map<number, string[]>>();
  for (const record of installations) {
    const version = parseVersion(record.version);
    const key = groupKey(record.vendor, record.product);
    let group = byGroup.get(key);
    if (group === undefined) {
      group = new Map();
      byGroup.set(key, group);
    }
    const ids = group.get(version);
    if (ids === undefined) {
      group.set(version, [record.id]);
    } else {
      ids.push(record.id);
    }
  }

  const keys = [...byGroup.keys()].sort();
  for (const key of keys) {
    const index = db.groups.get(key);
    if (index === undefined) {
      continue;
    }
    const versionsOfGroup = byGroup.get(key) as Map<number, string[]>;
    const versions = [...versionsOfGroup.keys()].sort((a, b) => a - b);
    for (const ids of versionsOfGroup.values()) {
      ids.sort();
    }

    // 扫描线：版本升序推进，事件流单调消费，active 维护当前命中的 CVE 集合。
    const events = index.events;
    const counts = new Array<number>(index.cveIds.length).fill(0);
    const active = new Set<number>();
    let cursor = 0;

    for (const version of versions) {
      while (cursor < events.length) {
        const event = events[cursor];
        if (event === undefined || event.pos > version) {
          break;
        }
        const next = (counts[event.cve] as number) + event.delta;
        counts[event.cve] = next;
        if (next === 1 && event.delta === 1) {
          active.add(event.cve);
        } else if (next === 0) {
          active.delete(event.cve);
        }
        cursor += 1;
      }
      if (active.size === 0) {
        continue;
      }
      const ids = versionsOfGroup.get(version) as string[];
      for (const local of active) {
        const cveId = index.cveIds[local] as string;
        for (const id of ids) {
          yield { installationId: id, cveId };
        }
      }
    }
  }
}
