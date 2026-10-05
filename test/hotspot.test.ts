import assert from "node:assert/strict";
import test from "node:test";
import { buildDatabase, matchInventory, matchInventoryIter } from "../src/index";
import type {
  ApplicabilityItem,
  CveEntry,
  InstallRecord,
  VulnerabilityDatabaseFile,
} from "../src/index";

const HOT_ITEMS = 160_000; // 热点厂商+产品的适用项数
const OTHER_ITEMS = 40_000; // 其余分组的适用项数
const MULTI_ITEMS_A = 2_000; // 同一 CVE 的重叠适用项数（批次二）
const MULTI_ITEMS_B = 1_000;
const HOT_INSTALLS = 80_000; // 热点分组安装记录数
const OTHER_INSTALLS = 20_000;

function makeDatabase(): VulnerabilityDatabaseFile {
  const cves: CveEntry[] = [];
  // 热点分组：160k 适用项，区间全部重叠于 [1.0.0, 2.0.0]，
  // 每项各带一条排除区间，排除 [1.0.0, 1.65535.65535]（即查询集中区）。
  for (let i = 0; i < HOT_ITEMS; i += 1) {
    const item: ApplicabilityItem = {
      vendor: "hot",
      product: "app",
      range: {
        lower: { version: "1.0.0", inclusive: true },
        upper: { version: "2.0.0", inclusive: true },
      },
      exclusions: [
        {
          lower: { version: "1.0.0", inclusive: true },
          upper: { version: "1.65535.65535", inclusive: true },
        },
      ],
    };
    cves.push({ id: `CVE-EX-${i}`, items: [item] });
  }
  // 其余分组：40k 个适用项各自独立分组与 CVE，各带一条排除区间。
  for (let i = 0; i < OTHER_ITEMS; i += 1) {
    cves.push({
      id: `CVE-OTHER-${i}`,
      items: [
        {
          vendor: `v${i}`,
          product: `p${i}`,
          range: {
            lower: { version: "0.0.0", inclusive: true },
            upper: { version: "9.0.0", inclusive: true },
          },
          exclusions: [
            {
              lower: { version: "5.0.0", inclusive: true },
              upper: { version: "6.0.0", inclusive: true },
            },
          ],
        },
      ],
    });
  }
  // 多适用项分组：两个 CVE 的大量重叠适用项覆盖 [3.0.0, 4.0.0]。
  const multiItemsA: ApplicabilityItem[] = [];
  for (let i = 0; i < MULTI_ITEMS_A; i += 1) {
    multiItemsA.push({
      vendor: "hot2",
      product: "app2",
      range: {
        lower: { version: "3.0.0", inclusive: true },
        upper: { version: "4.0.0", inclusive: true },
      },
    });
  }
  const multiItemsB: ApplicabilityItem[] = [];
  for (let i = 0; i < MULTI_ITEMS_B; i += 1) {
    multiItemsB.push({
      vendor: "hot2",
      product: "app2",
      range: {
        lower: { version: "3.0.0", inclusive: true },
        upper: { version: "4.0.0", inclusive: true },
      },
    });
  }
  cves.push({ id: "CVE-HOT-A", items: multiItemsA });
  cves.push({ id: "CVE-HOT-B", items: multiItemsB });
  return { cves };
}

function makeExcludedHeavyBatch(): InstallRecord[] {
  const records: InstallRecord[] = [];
  // 80k 条热点分组记录，版本全部落在被排除的 [1.0.0, 1.65535.65535] 内。
  for (let i = 0; i < HOT_INSTALLS; i += 1) {
    records.push({
      id: `hot-${i}`,
      vendor: "hot",
      product: "app",
      version: `1.${i % 65536}.${Math.floor(i / 65536)}`,
    });
  }
  // 20k 条其余分组记录，各自命中所在分区的唯一 CVE。
  for (let i = 0; i < OTHER_INSTALLS; i += 1) {
    records.push({
      id: `other-${i}`,
      vendor: `v${i}`,
      product: `p${i}`,
      version: "1.0.0",
    });
  }
  return records;
}

function makeMultiItemBatch(): InstallRecord[] {
  const records: InstallRecord[] = [];
  for (let i = 0; i < HOT_INSTALLS; i += 1) {
    records.push({
      id: `multi-${i}`,
      vendor: "hot2",
      product: "app2",
      version: "3.5.0",
    });
  }
  return records;
}

test("热点规模：加载 20 万适用项 + 20 万排除区间不超过 15 秒", () => {
  const start = performance.now();
  const db = buildDatabase(makeDatabase());
  const elapsed = (performance.now() - start) / 1000;
  assert.equal(db.itemCount, HOT_ITEMS + OTHER_ITEMS + MULTI_ITEMS_A + MULTI_ITEMS_B);
  assert.ok(elapsed < 15, `加载耗时 ${elapsed.toFixed(2)}s 应小于 15s`);
});

test("热点规模：低命中批次与多适用项批次完整产出、无重复、8 秒内", () => {
  const db = buildDatabase(makeDatabase());

  // 批次一：大量重叠区间被排除，只有其余分组的 20k 条命中。
  let start = performance.now();
  const batchA = matchInventory(db, makeExcludedHeavyBatch());
  let elapsed = (performance.now() - start) / 1000;
  assert.ok(elapsed < 8, `批次一耗时 ${elapsed.toFixed(2)}s 应小于 8s`);
  assert.equal(batchA.length, OTHER_INSTALLS);
  assert.equal(new Set(batchA.map((r) => `${r.recordId}${r.cveId}`)).size, batchA.length);
  for (const rel of batchA) {
    const i = Number(rel.recordId.slice("other-".length));
    assert.equal(rel.cveId, `CVE-OTHER-${i}`);
  }

  // 批次二：80k 条记录各自命中同一 CVE 的多个适用项，每个 CVE 只返回一次。
  start = performance.now();
  const batchB = matchInventory(db, makeMultiItemBatch());
  elapsed = (performance.now() - start) / 1000;
  assert.ok(elapsed < 8, `批次二耗时 ${elapsed.toFixed(2)}s 应小于 8s`);
  assert.equal(batchB.length, HOT_INSTALLS * 2);
  assert.equal(new Set(batchB.map((r) => `${r.recordId}${r.cveId}`)).size, batchB.length);
  const perRecord = new Map<string, string[]>();
  for (const rel of batchB) {
    perRecord.set(rel.recordId, [...(perRecord.get(rel.recordId) ?? []), rel.cveId]);
  }
  for (const [, cveIds] of perRecord) {
    assert.deepEqual(cveIds.sort(), ["CVE-HOT-A", "CVE-HOT-B"]);
  }
});

test("热点规模：逐条流式消费时内存增量不超过 512 MiB", () => {
  const db = buildDatabase(makeDatabase());
  const records = [...makeExcludedHeavyBatch(), ...makeMultiItemBatch()];
  const baseline = process.memoryUsage().rss;
  let count = 0;
  for (const rel of matchInventoryIter(db, records)) {
    // 调用方逐条消费，不保留结果。
    void rel;
    count += 1;
  }
  assert.equal(count, OTHER_INSTALLS + HOT_INSTALLS * 2);
  const growthMiB = (process.memoryUsage().rss - baseline) / (1024 * 1024);
  assert.ok(growthMiB < 512, `内存增量 ${growthMiB.toFixed(1)} MiB 应小于 512 MiB`);
});
