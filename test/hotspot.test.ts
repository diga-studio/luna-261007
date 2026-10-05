import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { loadDatabase, matchInstallations } from "../src/index.js";
import type {
  ApplicableItem,
  CveEntry,
  InstallationRecord,
  VulnerabilityDbFile,
} from "../src/index.js";

const HOT_VENDOR = "hot-vendor";
const HOT_PRODUCT = "hot-product";
const OTHER_GROUPS = 40;
const OTHER_ITEMS_PER_GROUP = 1000;
const HOT_CVE_COUNT = 2000;
const HOT_ITEMS_PER_CVE = 70;
const DUP_ITEM_COUNT = 20000;

const LOAD_BUDGET_MS = 15_000;
const MATCH_BUDGET_MS = 8_000;
const MEMORY_BUDGET_BYTES = 512 * 1024 * 1024;

/** 构造 20 万适用项 + 20 万排除区间的漏洞库，热点组占 16 万适用项。 */
function buildDbFile(): VulnerabilityDbFile {
  const cves: CveEntry[] = [];

  // 热点组：2000 个 CVE，每个 70 条高度重叠的适用项，
  // 每条适用项都排除 [1.5.0, 1.6.0)，共 14 万项。
  for (let c = 0; c < HOT_CVE_COUNT; c += 1) {
    const items: ApplicableItem[] = [];
    for (let i = 0; i < HOT_ITEMS_PER_CVE; i += 1) {
      items.push({
        vendor: HOT_VENDOR,
        product: HOT_PRODUCT,
        range: {
          lower: { version: "1.0.0", inclusive: true },
          upper: { version: "1.65535.65535", inclusive: true },
        },
        exclusions: [
          {
            lower: { version: "1.5.0", inclusive: true },
            upper: { version: "1.6.0", inclusive: false },
          },
        ],
      });
    }
    cves.push({ cveId: `CVE-HOT-${c}`, items });
  }

  // 热点组内同一 CVE 挂 2 万条适用项，用于多适用项去重场景。
  const dupItems: ApplicableItem[] = [];
  for (let i = 0; i < DUP_ITEM_COUNT; i += 1) {
    dupItems.push({
      vendor: HOT_VENDOR,
      product: HOT_PRODUCT,
      range: {
        lower: { version: "2.0.0", inclusive: true },
        upper: { version: "2.65535.65535", inclusive: true },
      },
      exclusions: [
        {
          lower: { version: "2.5.0", inclusive: true },
          upper: { version: "2.6.0", inclusive: false },
        },
      ],
    });
  }
  cves.push({ cveId: "CVE-DUP", items: dupItems });

  // 其余 40 个分组各 1000 项，合计 4 万项，总计 20 万适用项。
  for (let g = 0; g < OTHER_GROUPS; g += 1) {
    const items: ApplicableItem[] = [];
    for (let i = 0; i < OTHER_ITEMS_PER_GROUP; i += 1) {
      items.push({
        vendor: `vendor-${g}`,
        product: `product-${g}`,
        range: {
          lower: { version: "5.0.0", inclusive: true },
          upper: { version: "5.65535.65535", inclusive: true },
        },
        exclusions: [
          {
            lower: { version: "5.100.0", inclusive: true },
            upper: { version: "5.200.0", inclusive: false },
          },
        ],
      });
    }
    cves.push({ cveId: `CVE-OTH-${g}`, items });
  }

  return { cves };
}

function hotInstallations(prefix: string, count: number, version: (i: number) => string): InstallationRecord[] {
  const records: InstallationRecord[] = [];
  for (let i = 0; i < count; i += 1) {
    records.push({ id: `${prefix}-${i}`, vendor: HOT_VENDOR, product: HOT_PRODUCT, version: version(i) });
  }
  return records;
}

function otherInstallations(prefix: string, count: number, version: string): InstallationRecord[] {
  const records: InstallationRecord[] = [];
  for (let i = 0; i < count; i += 1) {
    const g = i % OTHER_GROUPS;
    records.push({ id: `${prefix}-${i}`, vendor: `vendor-${g}`, product: `product-${g}`, version });
  }
  return records;
}

function elapsedMs(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1e6;
}

test("热点规模：加载、低命中批次、多去重批次的耗时与内存", () => {
  const dbFile = buildDbFile();
  const itemCount = dbFile.cves.reduce((n, c) => n + c.items.length, 0);
  const exclusionCount = dbFile.cves.reduce(
    (n, c) => n + c.items.reduce((m, it) => m + (it.exclusions?.length ?? 0), 0),
    0,
  );
  equal(itemCount, 200_000);
  equal(exclusionCount, 200_000);

  const loadStart = process.hrtime.bigint();
  const db = loadDatabase(dbFile);
  const loadMs = elapsedMs(loadStart);
  ok(loadMs < LOAD_BUDGET_MS, `加载耗时 ${loadMs.toFixed(0)}ms 应小于 ${LOAD_BUDGET_MS}ms`);

  // 低命中批次：8 万热点记录全部落入公共排除带，2 万其他记录不在任何区间。
  const lowHitBatch = [
    ...hotInstallations("low", 80_000, (i) => `1.5.${i % 65536}`),
    ...otherInstallations("low-o", 20_000, "3.0.0"),
  ];
  const lowStart = process.hrtime.bigint();
  let lowRelations = 0;
  for (const rel of matchInstallations(db, lowHitBatch)) {
    void rel;
    lowRelations += 1;
  }
  const lowMs = elapsedMs(lowStart);
  equal(lowRelations, 0);
  ok(lowMs < MATCH_BUDGET_MS, `低命中批次耗时 ${lowMs.toFixed(0)}ms 应小于 ${MATCH_BUDGET_MS}ms`);

  // 多去重批次：8 万热点记录各自命中 CVE-DUP 的 2 万条适用项（去重后 1 条），
  // 2 万其他记录各命中本组 CVE，共 10 万条关系。
  const dupBatch = [
    ...hotInstallations("dup", 80_000, () => "2.100.0"),
    ...otherInstallations("dup-o", 20_000, "5.300.0"),
  ];
  const dupStart = process.hrtime.bigint();
  const seen = new Set<string>();
  let dupRelations = 0;
  let peakRss = process.memoryUsage().rss;
  for (const rel of matchInstallations(db, dupBatch)) {
    seen.add(`${rel.installationId} ${rel.cveId}`);
    dupRelations += 1;
    if ((dupRelations & 0x3fff) === 0) {
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }
  }
  const dupMs = elapsedMs(dupStart);
  equal(dupRelations, 100_000);
  equal(seen.size, dupRelations, "关系无重复");
  ok(dupMs < MATCH_BUDGET_MS, `多去重批次耗时 ${dupMs.toFixed(0)}ms 应小于 ${MATCH_BUDGET_MS}ms`);

  // 同一批清单重复调用结果一致。
  const again = [...matchInstallations(db, dupBatch)];
  equal(again.length, dupRelations);
  for (const rel of again) {
    ok(seen.has(`${rel.installationId} ${rel.cveId}`));
  }

  peakRss = Math.max(peakRss, process.memoryUsage().rss);
  ok(
    peakRss < MEMORY_BUDGET_BYTES,
    `峰值内存 ${(peakRss / 1024 / 1024).toFixed(0)}MiB 应小于 512MiB`,
  );
});
