import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { CampaignForge } from "../src/index.js";
import type { TemplateContent } from "../src/index.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "campaign-forge-"));
}

function contentFor(n: number): TemplateContent {
  return {
    tokens: { product: `p${n}` },
    blocks: { headline: `v${n} {{product}}` },
  };
}

test("revisions get increasing numbers and take effect as a whole", () => {
  const forge = new CampaignForge({ storagePath: tempDir() });
  const r1 = forge.submitRevision("landing", contentFor(1));
  const r2 = forge.submitRevision("landing", contentFor(2));
  assert.equal(r1.revision, 1);
  assert.equal(r2.revision, 2);
  assert.equal(r2.content.blocks.headline, "v2 {{product}}");
});

test("history read returns only the most recent 20 revisions", () => {
  const forge = new CampaignForge({ storagePath: tempDir() });
  for (let i = 1; i <= 25; i++) {
    forge.submitRevision("landing", contentFor(i));
  }
  const history = forge.readHistory("landing");
  assert.equal(history.length, 20);
  assert.equal(history[0].revision, 25);
  assert.equal(history[19].revision, 6);
});

test("recent 20 revisions survive a restart", () => {
  const dir = tempDir();
  const forge = new CampaignForge({ storagePath: dir });
  for (let i = 1; i <= 25; i++) {
    forge.submitRevision("landing", contentFor(i));
  }
  const reopened = new CampaignForge({ storagePath: dir });
  const history = reopened.readHistory("landing");
  assert.equal(history.length, 20);
  assert.equal(history[0].revision, 25);
  assert.equal(history[19].revision, 6);
  assert.equal(history[0].content.blocks.headline, "v25 {{product}}");
});

test("history is tracked per template", () => {
  const forge = new CampaignForge({ storagePath: tempDir() });
  forge.submitRevision("a", contentFor(1));
  forge.submitRevision("b", contentFor(2));
  assert.equal(forge.readHistory("a")[0].revision, 1);
  assert.equal(forge.readHistory("b")[0].revision, 1);
  assert.equal(forge.readHistory("missing").length, 0);
});
