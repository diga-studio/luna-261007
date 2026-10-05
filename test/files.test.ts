import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  loadDatabaseFile,
  loadInventoryFile,
  matchInventory,
} from "../src/index";

test("从本地 JSON 文件加载漏洞库与清单并匹配", () => {
  const dir = mkdtempSync(join(tmpdir(), "cve-matcher-"));
  try {
    const dbPath = join(dir, "vulns.json");
    const invPath = join(dir, "inventory.json");
    writeFileSync(
      dbPath,
      JSON.stringify({
        cves: [
          {
            id: "CVE-FILE-1",
            items: [
              {
                vendor: "acme",
                product: "app",
                range: {
                  lower: { version: "1.0.0", inclusive: true },
                  upper: { version: "2.0.0", inclusive: false },
                },
              },
            ],
          },
        ],
      }),
    );
    writeFileSync(
      invPath,
      JSON.stringify({
        records: [
          { id: "h1", vendor: "acme", product: "app", version: "1.5.0" },
          { id: "h2", vendor: "acme", product: "app", version: "2.0.0" },
        ],
      }),
    );
    const db = loadDatabaseFile(dbPath);
    const records = loadInventoryFile(invPath);
    assert.deepEqual(matchInventory(db, records), [
      { recordId: "h1", cveId: "CVE-FILE-1" },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("文件格式非法时报错", () => {
  const dir = mkdtempSync(join(tmpdir(), "cve-matcher-"));
  try {
    const badDb = join(dir, "bad.json");
    writeFileSync(badDb, JSON.stringify({ nope: [] }));
    assert.throws(() => loadDatabaseFile(badDb));
    const badInv = join(dir, "bad-inv.json");
    writeFileSync(badInv, JSON.stringify({ records: [{ id: "x" }] }));
    assert.throws(() => loadInventoryFile(badInv));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
