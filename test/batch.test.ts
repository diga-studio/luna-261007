import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { CampaignForge, renderTemplate } from "../src/index.js";
import type {
  PageInput,
  PageResult,
  TemplateContent,
  TemplateRevision,
} from "../src/index.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "campaign-forge-"));
}

function contentFor(n: number): TemplateContent {
  return {
    tokens: { product: `p${n}` },
    blocks: { headline: `v${n} {{product}}` },
  };
}

async function collect(stream: AsyncIterable<PageResult>): Promise<PageResult[]> {
  const out: PageResult[] = [];
  for await (const result of stream) {
    out.push(result);
  }
  return out;
}

function storedRevisions(dir: string, templateId: string): number[] {
  const raw = fs.readFileSync(path.join(dir, "revisions.json"), "utf8");
  const data = JSON.parse(raw) as Record<string, TemplateRevision[]>;
  return (data[templateId] ?? []).map((r) => r.revision);
}

test("batch bound before 20 revisions still renders its pinned revision", async () => {
  const dir = tempDir();
  const forge = new CampaignForge({ storagePath: dir });
  forge.submitRevision("t", contentFor(1));
  const boundContent = contentFor(1);

  const batch = forge.startBatch(["t"]);
  // 24 more revisions land before the first page arrives.
  for (let i = 2; i <= 25; i++) {
    forge.submitRevision("t", contentFor(i));
  }
  // Revision 1 left the read window...
  const history = forge.readHistory("t");
  assert.equal(history.length, 20);
  assert.equal(history[19].revision, 6);
  // ...but stays pinned on disk for the live batch.
  assert.ok(storedRevisions(dir, "t").includes(1));

  batch.submit({ templateId: "t", params: { product: "shoes" } });
  batch.submit({ templateId: "t", params: {} });
  batch.finish();
  const results = await collect(batch.results());

  assert.equal(results.length, 2);
  assert.equal(results[0].revision, 1);
  assert.deepEqual(
    results[0].output,
    renderTemplate(boundContent, { product: "shoes" }),
  );
  assert.deepEqual(results[1].output, renderTemplate(boundContent, {}));
  assert.equal(batch.state, "completed");

  // After the batch settled, revision 1 loses its retention资格.
  assert.ok(!storedRevisions(dir, "t").includes(1));
});

test("later submissions do not affect a running batch; new batches rebind", async () => {
  const forge = new CampaignForge({ storagePath: tempDir() });
  forge.submitRevision("t", contentFor(1));
  const first = forge.startBatch(["t"]);
  forge.submitRevision("t", contentFor(2));
  const second = forge.startBatch(["t"]);

  first.submit({ templateId: "t", params: {} });
  first.finish();
  second.submit({ templateId: "t", params: {} });
  second.finish();

  const firstResults = await collect(first.results());
  const secondResults = await collect(second.results());
  assert.equal(firstResults[0].revision, 1);
  assert.equal(firstResults[0].output.headline, "v1 p1");
  assert.equal(secondResults[0].revision, 2);
  assert.equal(secondResults[0].output.headline, "v2 p2");
});

test("results stream in input order without waiting for end of input", async () => {
  const forge = new CampaignForge({ storagePath: tempDir() });
  forge.submitRevision("t", contentFor(1));
  const batch = forge.startBatch(["t"]);
  const iterator = batch.results()[Symbol.asyncIterator]();

  batch.submit({ templateId: "t", params: { product: "a" } });
  const first = await iterator.next();
  assert.equal(first.done, false);
  assert.equal(first.value.sequence, 0);
  assert.equal(first.value.output.headline, "v1 a");

  batch.submit({ templateId: "t", params: { product: "b" } });
  const second = await iterator.next();
  assert.equal(second.value.sequence, 1);
  assert.equal(second.value.output.headline, "v1 b");

  batch.finish();
  const end = await iterator.next();
  assert.equal(end.done, true);
});

test("cancel while waiting for input completes and stops delivery", async () => {
  const forge = new CampaignForge({ storagePath: tempDir() });
  forge.submitRevision("t", contentFor(1));
  const batch = forge.startBatch(["t"]);
  const iterator = batch.results()[Symbol.asyncIterator]();

  const pending = iterator.next();
  await batch.cancel();
  const result = await pending;
  assert.equal(result.done, true);
  assert.equal(batch.state, "cancelled");
  assert.throws(() => batch.submit({ templateId: "t", params: {} }));
});

test("cancel while consumption is paused completes without the consumer", async () => {
  const forge = new CampaignForge({ storagePath: tempDir() });
  forge.submitRevision("t", contentFor(1));
  const batch = forge.startBatch(["t"]);
  batch.submit({ templateId: "t", params: { product: "a" } });
  batch.submit({ templateId: "t", params: { product: "b" } });

  const iterator = batch.results()[Symbol.asyncIterator]();
  const first = await iterator.next();
  assert.equal(first.value.output.headline, "v1 a");

  // Consumer pauses; cancellation must not wait for it.
  await batch.cancel();
  assert.equal(batch.state, "cancelled");

  // When the consumer resumes, no further results are delivered.
  const rest = await iterator.next();
  assert.equal(rest.done, true);
});

test("cancel before any page still releases revision pins", async () => {
  const dir = tempDir();
  const forge = new CampaignForge({ storagePath: dir });
  forge.submitRevision("t", contentFor(1));
  const batch = forge.startBatch(["t"]);
  for (let i = 2; i <= 25; i++) {
    forge.submitRevision("t", contentFor(i));
  }
  assert.ok(storedRevisions(dir, "t").includes(1));
  await batch.cancel();
  assert.ok(!storedRevisions(dir, "t").includes(1));
});

test("every delivered result matches a standalone full render of the bound revision", async () => {
  const forge = new CampaignForge({ storagePath: tempDir() });
  const shared: TemplateContent = {
    tokens: { product: "dp", cta: "dc", empty: "de" },
    blocks: {
      h: "{{product}}!",
      deep: { cta: "{{cta}}", list: ["{{empty}}", 7] },
    },
  };
  forge.submitRevision("a", shared);
  forge.submitRevision("b", contentFor(9));
  const batch = forge.startBatch(["a", "b"]);
  forge.submitRevision("a", contentFor(2)); // must not leak into the batch

  const pages: PageInput[] = [
    { templateId: "a", params: { product: "x", cta: "", empty: "" } },
    { templateId: "b", params: {} },
    { templateId: "a", params: {} },
    { templateId: "a", params: { product: "{{cta}}" } },
  ];
  for (const page of pages) {
    batch.submit(page);
  }
  batch.finish();
  const results = await collect(batch.results());

  assert.equal(results.length, pages.length);
  const bound: Record<string, TemplateContent> = { a: shared, b: contentFor(9) };
  results.forEach((result, i) => {
    assert.equal(result.sequence, i);
    assert.equal(result.templateId, pages[i].templateId);
    assert.deepEqual(
      result.output,
      renderTemplate(bound[pages[i].templateId], pages[i].params),
    );
  });
});

test("pages outside the manifest are rejected", async () => {
  const forge = new CampaignForge({ storagePath: tempDir() });
  forge.submitRevision("t", contentFor(1));
  const batch = forge.startBatch(["t"]);
  assert.throws(() => batch.submit({ templateId: "other", params: {} }));
  await batch.cancel();
});

test("starting a batch for an unknown template fails", () => {
  const forge = new CampaignForge({ storagePath: tempDir() });
  assert.throws(() => forge.startBatch(["nope"]));
});
