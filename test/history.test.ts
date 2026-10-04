import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CampaignForge } from "../src/index";
import type { Template } from "../src/index";

function makeTemplate(tag: string): Template {
  return {
    blocks: { headline: `rev-${tag}: {{product}}` },
    tokens: { product: { default: `default-${tag}` } },
  };
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "campaignforge-"));
}

test("历史读取只开放最近20个修订（含当前修订），按修订号升序", () => {
  const dir = tempDir();
  const forge = new CampaignForge({ dataDir: dir });
  for (let i = 1; i <= 25; i++) {
    assert.equal(forge.submitRevision("t1", makeTemplate(String(i))), i);
  }
  const history = forge.getHistory("t1");
  assert.equal(history.length, 20);
  assert.equal(history[0]!.revision, 6);
  assert.equal(history[19]!.revision, 25);
  assert.deepEqual(
    history.map((r) => r.revision),
    Array.from({ length: 20 }, (_, i) => i + 6),
  );
  forge.close();
});

test("正常重启后最近20个修订仍可读取", () => {
  const dir = tempDir();
  const forge1 = new CampaignForge({ dataDir: dir });
  for (let i = 1; i <= 23; i++) forge1.submitRevision("t1", makeTemplate(String(i)));
  forge1.close();

  const forge2 = new CampaignForge({ dataDir: dir });
  const history = forge2.getHistory("t1");
  assert.equal(history.length, 20);
  assert.equal(history[0]!.revision, 4);
  assert.equal(history[19]!.revision, 23);
  const first = history[0]!.template.blocks as any;
  assert.equal(first.headline, "rev-4: {{product}}");
  forge2.close();
});

test("无修订的模板历史为空", () => {
  const dir = tempDir();
  const forge = new CampaignForge({ dataDir: dir });
  assert.deepEqual(forge.getHistory("nope"), []);
  forge.close();
});
