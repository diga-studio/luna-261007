import { test } from "node:test";
import { deepEqual, equal, throws } from "node:assert/strict";
import { loadDatabase, matchInstallations, parseVersion } from "../src/index.js";
import type { InstallationRecord, VulnerabilityDbFile } from "../src/index.js";

function relationsFor(
  dbFile: VulnerabilityDbFile,
  records: InstallationRecord[],
): { installationId: string; cveId: string }[] {
  return [...matchInstallations(loadDatabase(dbFile), records)];
}

function inst(id: string, version: string, vendor = "v", product = "p"): InstallationRecord {
  return { id, vendor, product, version };
}

test("缺省上下界：无界区间命中任意版本", () => {
  const db: VulnerabilityDbFile = {
    cves: [
      {
        cveId: "CVE-OPEN",
        items: [{ vendor: "v", product: "p", range: {} }],
      },
      {
        cveId: "CVE-UP",
        items: [
          {
            vendor: "v",
            product: "p",
            range: { upper: { version: "1.0.0", inclusive: true } },
          },
        ],
      },
      {
        cveId: "CVE-DOWN",
        items: [
          {
            vendor: "v",
            product: "p",
            range: { lower: { version: "2.0.0", inclusive: false } },
          },
        ],
      },
    ],
  };
  const rel = relationsFor(db, [inst("a", "0.0.0"), inst("b", "1.0.0"), inst("c", "2.0.0"), inst("d", "65535.65535.65535")]);
  const byId = new Map<string, string[]>();
  for (const r of rel) {
    byId.set(r.installationId, [...(byId.get(r.installationId) ?? []), r.cveId]);
  }
  deepEqual(byId.get("a")?.sort(), ["CVE-OPEN", "CVE-UP"]);
  deepEqual(byId.get("b")?.sort(), ["CVE-OPEN", "CVE-UP"]);
  deepEqual(byId.get("c")?.sort(), ["CVE-OPEN"]);
  deepEqual(byId.get("d")?.sort(), ["CVE-DOWN", "CVE-OPEN"]);
});

test("多个排除区间交叠：按并集排除", () => {
  const db: VulnerabilityDbFile = {
    cves: [
      {
        cveId: "CVE-X",
        items: [
          {
            vendor: "v",
            product: "p",
            range: {
              lower: { version: "1.0.0", inclusive: true },
              upper: { version: "1.9.0", inclusive: true },
            },
            exclusions: [
              {
                lower: { version: "1.2.0", inclusive: true },
                upper: { version: "1.4.0", inclusive: true },
              },
              {
                lower: { version: "1.3.0", inclusive: true },
                upper: { version: "1.5.0", inclusive: false },
              },
              {
                lower: { version: "1.7.0", inclusive: false },
                upper: { version: "1.8.0", inclusive: false },
              },
            ],
          },
        ],
      },
    ],
  };
  const cases: [string, boolean][] = [
    ["1.1.0", true],
    ["1.2.0", false],
    ["1.4.0", false],
    ["1.5.0", true],
    ["1.7.0", true],
    ["1.7.1", false],
    ["1.8.0", true],
    ["1.9.0", true],
  ];
  for (const [version, hit] of cases) {
    const rel = relationsFor(db, [inst("t", version)]);
    equal(rel.length, hit ? 1 : 0, `version ${version}`);
  }
});

test("排除只影响所属适用项，同 CVE 其他适用项仍可命中", () => {
  const db: VulnerabilityDbFile = {
    cves: [
      {
        cveId: "CVE-M",
        items: [
          {
            vendor: "v",
            product: "p",
            range: {
              lower: { version: "1.0.0", inclusive: true },
              upper: { version: "2.0.0", inclusive: true },
            },
            exclusions: [
              {
                lower: { version: "1.5.0", inclusive: true },
                upper: { version: "1.5.0", inclusive: true },
              },
            ],
          },
          {
            vendor: "v",
            product: "p",
            range: {
              lower: { version: "1.5.0", inclusive: true },
              upper: { version: "1.5.0", inclusive: true },
            },
          },
        ],
      },
    ],
  };
  const rel = relationsFor(db, [inst("only", "1.5.0")]);
  deepEqual(rel, [{ installationId: "only", cveId: "CVE-M" }]);
});

test("同版本安装在不同终端：分别产出关系，不合并", () => {
  const db: VulnerabilityDbFile = {
    cves: [
      {
        cveId: "CVE-S",
        items: [{ vendor: "v", product: "p", range: {} }],
      },
    ],
  };
  const rel = relationsFor(db, [inst("host-1", "1.0.0"), inst("host-2", "1.0.0"), inst("host-3", "1.0.0")]);
  deepEqual(
    rel.map((r) => r.installationId).sort(),
    ["host-1", "host-2", "host-3"],
  );
  equal(new Set(rel.map((r) => r.installationId)).size, 3);
});

test("厂商或产品不匹配的记录不产生关系", () => {
  const db: VulnerabilityDbFile = {
    cves: [
      {
        cveId: "CVE-V",
        items: [{ vendor: "v", product: "p", range: {} }],
      },
    ],
  };
  const rel = relationsFor(db, [
    inst("a", "1.0.0", "other", "p"),
    inst("b", "1.0.0", "v", "other"),
    inst("c", "1.0.0", "v", "p"),
  ]);
  deepEqual(rel, [{ installationId: "c", cveId: "CVE-V" }]);
});

test("版本编码与三段数值比较一致，非法版本报错", () => {
  equal(parseVersion("0.0.0"), 0);
  equal(parseVersion("1.0.0") > parseVersion("0.65535.65535"), true);
  equal(parseVersion("1.2.3") < parseVersion("1.2.10"), true);
  equal(parseVersion("65535.65535.65535") < Number.MAX_SAFE_INTEGER, true);
  throws(() => parseVersion("1.2"));
  throws(() => parseVersion("1.2.3.4"));
  throws(() => parseVersion("1.2.65536"));
  throws(() => parseVersion("1.2.-3"));
  throws(() => parseVersion("1.2.3-alpha"));
});
