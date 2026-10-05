import { test } from "node:test";
import { deepEqual } from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDatabase, loadDatabaseFromFile, matchInstallations } from "../src/index.js";
import type { InstallationRecord, VulnerabilityDbFile } from "../src/index.js";

const VENDOR = "vendor-v";
const PRODUCT = "product-p";

/** 验收规定的小规模漏洞库：所有规则属于同一厂商与产品。 */
const dbFile: VulnerabilityDbFile = {
  cves: [
    {
      cveId: "CVE-A",
      items: [
        {
          vendor: VENDOR,
          product: PRODUCT,
          range: {
            lower: { version: "1.2.0", inclusive: false },
            upper: { version: "2.0.0", inclusive: true },
          },
          exclusions: [
            {
              lower: { version: "1.5.0", inclusive: true },
              upper: { version: "1.6.0", inclusive: false },
            },
          ],
        },
        {
          vendor: VENDOR,
          product: PRODUCT,
          range: {
            lower: { version: "1.4.0", inclusive: true },
            upper: { version: "1.5.0", inclusive: true },
          },
        },
      ],
    },
    {
      cveId: "CVE-B",
      items: [
        {
          vendor: VENDOR,
          product: PRODUCT,
          range: {
            lower: { version: "1.5.0", inclusive: true },
            upper: { version: "1.6.0", inclusive: false },
          },
        },
      ],
    },
  ],
};

const EXPECTED: Record<string, string[]> = {
  "1.2.0": [],
  "1.4.0": ["CVE-A"],
  "1.5.0": ["CVE-A", "CVE-B"],
  "1.5.1": ["CVE-B"],
  "1.6.0": ["CVE-A"],
  "1.10.0": ["CVE-A"],
  "2.0.0": ["CVE-A"],
  "2.0.1": [],
};

function installations(): InstallationRecord[] {
  return Object.keys(EXPECTED).map((version, i) => ({
    id: `inst-${i}`,
    vendor: VENDOR,
    product: PRODUCT,
    version,
  }));
}

function collectByInstallation(
  relations: Iterable<{ installationId: string; cveId: string }>,
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const rel of relations) {
    const list = result.get(rel.installationId);
    if (list === undefined) {
      result.set(rel.installationId, [rel.cveId]);
    } else {
      list.push(rel.cveId);
    }
  }
  return result;
}

test("小规模场景：各版本命中集合与验收预期一致且无重复", () => {
  const db = loadDatabase(dbFile);
  const records = installations();
  const byId = collectByInstallation(matchInstallations(db, records));

  for (let i = 0; i < records.length; i += 1) {
    const record = records[i] as InstallationRecord;
    const expected = EXPECTED[record.version] as string[];
    const actual = (byId.get(record.id) ?? []).slice().sort();
    deepEqual(actual, expected.slice().sort(), `version ${record.version}`);
    deepEqual(new Set(actual).size, actual.length, `version ${record.version} 无重复`);
  }
});

test("重复调用与输入乱序产生相同的关系集合", () => {
  const db = loadDatabase(dbFile);
  const records = installations();
  const shuffled = [...records].reverse();

  const first = [...matchInstallations(db, records)];
  const second = [...matchInstallations(db, records)];
  const fromShuffled = [...matchInstallations(db, shuffled)];

  deepEqual(second, first);
  deepEqual(fromShuffled, first);
});

test("从本地 JSON 文件加载漏洞库", () => {
  const dir = mkdtempSync(join(tmpdir(), "cve-matcher-"));
  try {
    const path = join(dir, "db.json");
    writeFileSync(path, JSON.stringify(dbFile));
    const db = loadDatabaseFromFile(path);
    const byId = collectByInstallation(matchInstallations(db, installations()));
    deepEqual(byId.get("inst-2")?.sort(), ["CVE-A", "CVE-B"]);
    deepEqual(byId.get("inst-3"), ["CVE-B"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
