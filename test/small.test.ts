import assert from "node:assert/strict";
import test from "node:test";
import { buildDatabase, matchInventory } from "../src/index";
import type { InstallRecord, VulnerabilityDatabaseFile } from "../src/index";

const VENDOR = "acme";
const PRODUCT = "app";

const dbFile: VulnerabilityDatabaseFile = {
  cves: [
    {
      id: "CVE-A",
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
      id: "CVE-B",
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

function install(id: string, version: string): InstallRecord {
  return { id, vendor: VENDOR, product: PRODUCT, version };
}

test("小规模场景：命中集合与预期一致", () => {
  const db = buildDatabase(dbFile);
  const cases: Array<[string, string[]]> = [
    ["1.2.0", []],
    ["1.4.0", ["CVE-A"]],
    ["1.5.0", ["CVE-A", "CVE-B"]],
    ["1.5.1", ["CVE-B"]],
    ["1.6.0", ["CVE-A"]],
    ["1.10.0", ["CVE-A"]],
    ["2.0.0", ["CVE-A"]],
    ["2.0.1", []],
  ];
  const records = cases.map(([version], i) => install(`r${i}`, version));
  const relations = matchInventory(db, records);

  const actual = new Map<string, string[]>();
  for (const { recordId, cveId } of relations) {
    const list = actual.get(recordId) ?? [];
    list.push(cveId);
    actual.set(recordId, list);
  }
  cases.forEach(([version, expected], i) => {
    const got = (actual.get(`r${i}`) ?? []).sort();
    assert.deepEqual(got, [...expected].sort(), `version ${version}`);
    assert.equal(new Set(got).size, got.length, `version ${version} 集合内无重复`);
  });
  assert.equal(relations.length, cases.reduce((n, [, e]) => n + e.length, 0));
});
