import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDatabase,
  matchInventory,
  matchInventoryIter,
} from "../src/index";
import type { InstallRecord, VulnerabilityDatabaseFile } from "../src/index";

const V = "vendor1";
const P = "product1";

function install(id: string, version: string, vendor = V, product = P): InstallRecord {
  return { id, vendor, product, version };
}

test("缺省上下界：无下界从无版本起命中，无上界到任意高版本", () => {
  const db = buildDatabase({
    cves: [
      {
        id: "CVE-LOW",
        items: [
          {
            vendor: V,
            product: P,
            range: { upper: { version: "1.0.0", inclusive: true } },
          },
        ],
      },
      {
        id: "CVE-HIGH",
        items: [
          {
            vendor: V,
            product: P,
            range: { lower: { version: "2.0.0", inclusive: false } },
          },
        ],
      },
      {
        id: "CVE-ALL",
        items: [{ vendor: V, product: P, range: {} }],
      },
    ],
  });
  const records = [
    install("a", "0.0.0"),
    install("b", "1.0.0"),
    install("c", "1.0.1"),
    install("d", "2.0.0"),
    install("e", "65535.65535.65535"),
  ];
  const rel = matchInventory(db, records);
  const byRecord = new Map<string, string[]>();
  for (const { recordId, cveId } of rel) {
    byRecord.set(recordId, [...(byRecord.get(recordId) ?? []), cveId]);
  }
  assert.deepEqual(byRecord.get("a")?.sort(), ["CVE-ALL", "CVE-LOW"]);
  assert.deepEqual(byRecord.get("b")?.sort(), ["CVE-ALL", "CVE-LOW"]);
  assert.deepEqual(byRecord.get("c")?.sort(), ["CVE-ALL"]);
  assert.deepEqual(byRecord.get("d")?.sort(), ["CVE-ALL"]);
  assert.deepEqual(byRecord.get("e")?.sort(), ["CVE-ALL", "CVE-HIGH"]);
});

test("多个排除区间相互交叠：按并集扣除", () => {
  const db = buildDatabase({
    cves: [
      {
        id: "CVE-X",
        items: [
          {
            vendor: V,
            product: P,
            range: {
              lower: { version: "1.0.0", inclusive: true },
              upper: { version: "1.9.0", inclusive: true },
            },
            exclusions: [
              // 两个交叠的排除区间，并集覆盖 [1.2.0, 1.5.0)
              {
                lower: { version: "1.2.0", inclusive: true },
                upper: { version: "1.4.0", inclusive: true },
              },
              {
                lower: { version: "1.3.0", inclusive: false },
                upper: { version: "1.5.0", inclusive: false },
              },
              // 完全包住基础区间的排除不影响其他适用项
              {
                lower: { version: "9.9.9", inclusive: true },
              },
            ],
          },
          {
            vendor: V,
            product: P,
            range: {
              lower: { version: "1.3.5", inclusive: true },
              upper: { version: "1.3.9", inclusive: true },
            },
          },
        ],
      },
    ],
  });
  const records = [
    install("r1", "1.1.9"), // 命中第一项
    install("r2", "1.2.0"), // 被排除
    install("r3", "1.3.5"), // 第一项被排除，但命中第二项
    install("r4", "1.4.9"), // 被排除
    install("r5", "1.5.0"), // 命中第一项
    install("r6", "1.9.0"), // 命中第一项
    install("r7", "1.9.1"), // 不命中
  ];
  const rel = matchInventory(db, records);
  const hit = new Set(rel.map((r) => r.recordId));
  assert.deepEqual([...hit].sort(), ["r1", "r3", "r5", "r6"]);
  // 同一 CVE 只返回一次
  assert.equal(rel.filter((r) => r.recordId === "r3").length, 1);
});

test("排除区间只影响所属适用项", () => {
  const db = buildDatabase({
    cves: [
      {
        id: "CVE-Y",
        items: [
          {
            vendor: V,
            product: P,
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
            vendor: V,
            product: P,
            range: {
              lower: { version: "1.5.0", inclusive: true },
              upper: { version: "1.5.0", inclusive: true },
            },
          },
        ],
      },
    ],
  });
  const rel = matchInventory(db, [install("a", "1.5.0")]);
  assert.deepEqual(rel, [{ recordId: "a", cveId: "CVE-Y" }]);
});

test("同版本安装在不同终端：分别返回，不合并", () => {
  const db = buildDatabase({
    cves: [
      {
        id: "CVE-Z",
        items: [{ vendor: V, product: P, range: {} }],
      },
    ],
  });
  const records = [
    install("host-1", "1.0.0"),
    install("host-2", "1.0.0"),
    install("host-3", "1.0.0"),
  ];
  const rel = matchInventory(db, records);
  assert.equal(rel.length, 3);
  assert.deepEqual(
    rel.map((r) => r.recordId).sort(),
    ["host-1", "host-2", "host-3"],
  );
});

test("结果与输入排列顺序无关，重复调用结果一致", () => {
  const db = buildDatabase({
    cves: [
      {
        id: "CVE-1",
        items: [
          {
            vendor: V,
            product: P,
            range: { lower: { version: "1.0.0", inclusive: true } },
          },
        ],
      },
      {
        id: "CVE-2",
        items: [
          {
            vendor: V,
            product: P,
            range: { upper: { version: "3.0.0", inclusive: false } },
          },
        ],
      },
    ],
  });
  const records = [
    install("m", "2.0.0"),
    install("a", "0.5.0"),
    install("z", "9.9.9"),
    install("b", "1.0.0"),
  ];
  const shuffled = [records[2]!, records[0]!, records[3]!, records[1]!];
  const base = matchInventory(db, records);
  const permuted = matchInventory(db, shuffled);
  const again = matchInventory(db, records);
  assert.deepEqual(permuted, base);
  assert.deepEqual(again, base);
  // 结果按 (recordId, cveId) 排序
  const sorted = [...base].sort((x, y) =>
    x.recordId === y.recordId
      ? x.cveId.localeCompare(y.cveId)
      : x.recordId.localeCompare(y.recordId),
  );
  assert.deepEqual(base, sorted);
  // 生成器版本产出一致
  assert.deepEqual(Array.from(matchInventoryIter(db, records)), base);
});

test("厂商与产品精确匹配：不同厂商或产品不命中", () => {
  const db = buildDatabase({
    cves: [
      { id: "CVE-1", items: [{ vendor: V, product: P, range: {} }] },
    ],
  });
  const records = [
    install("ok", "1.0.0"),
    install("bad-vendor", "1.0.0", "other", P),
    install("bad-product", "1.0.0", V, "other"),
  ];
  const rel = matchInventory(db, records);
  assert.deepEqual(rel, [{ recordId: "ok", cveId: "CVE-1" }]);
});

test("非法版本与空区间", () => {
  assert.throws(() =>
    buildDatabase({
      cves: [
        {
          id: "CVE-BAD",
          items: [
            {
              vendor: V,
              product: P,
              range: { lower: { version: "1.2", inclusive: true } },
            },
          ],
        },
      ],
    }),
  );
  // 空适用区间（下界高于上界）永不命中；空排除区间不影响命中
  const db = buildDatabase({
    cves: [
      {
        id: "CVE-EMPTY",
        items: [
          {
            vendor: V,
            product: P,
            range: {
              lower: { version: "2.0.0", inclusive: false },
              upper: { version: "2.0.0", inclusive: false },
            },
          },
          {
            vendor: V,
            product: P,
            range: { upper: { version: "1.0.0", inclusive: true } },
            exclusions: [
              {
                lower: { version: "5.0.0", inclusive: false },
                upper: { version: "5.0.0", inclusive: true },
              },
            ],
          },
        ],
      },
    ],
  });
  const rel = matchInventory(db, [install("a", "2.0.0"), install("b", "1.0.0")]);
  assert.deepEqual(rel, [{ recordId: "b", cveId: "CVE-EMPTY" }]);
});
