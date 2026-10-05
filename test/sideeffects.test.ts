import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateDocx } from "../src/index.js";
import { buildZip } from "./helpers/zip.js";
import { docxEntries } from "./helpers/docx.js";

const dir = mkdtempSync(join(tmpdir(), "docx-side-"));
test.after(() => rmSync(dir, { recursive: true, force: true }));

test("validation leaves no extracted files and never modifies input", async () => {
  const good = buildZip(docxEntries());
  const bad = Buffer.from("not a zip at all, definitely not........");
  const goodPath = join(dir, "good.dat");
  const badPath = join(dir, "bad.dat");
  writeFileSync(goodPath, good);
  writeFileSync(badPath, bad);
  const before = readdirSync(dir).sort();

  const r1 = await validateDocx(goodPath);
  const r2 = await validateDocx(badPath);
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, false);

  assert.deepEqual(readdirSync(dir).sort(), before, "no files created");
  assert.deepEqual(readFileSync(goodPath), good, "accepted input untouched");
  assert.deepEqual(readFileSync(badPath), bad, "rejected input untouched");
});
